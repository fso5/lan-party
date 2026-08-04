package expo.modules.tankslan

import android.util.Base64
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.io.IOException
import java.net.InetAddress
import java.net.InetSocketAddress
import java.net.NetworkInterface
import java.net.ServerSocket
import java.net.Socket
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicInteger
import kotlin.concurrent.thread

/**
 * A raw TCP listener, and nothing else.
 *
 * Everything that makes this a game host -- the HTTP handshake, WebSocket
 * framing, masking, the match itself -- lives in TypeScript in @tanks/core,
 * where it runs under test in Node. This class exists only because a JavaScript
 * runtime on Android cannot bind a port.
 *
 * That split is deliberate and worth keeping. Code down here can only be
 * exercised by two people standing in a room with two phones, so the less of it
 * there is, the better. What remains is accept, read, write, close.
 */
class TanksLanModule : Module() {

  private var server: ServerSocket? = null
  private var acceptThread: Thread? = null
  private val conns = ConcurrentHashMap<String, Conn>()
  private val nextId = AtomicInteger(1)
  @Volatile private var running = false

  private class Conn(val socket: Socket) {
    // Writes go through a single-threaded executor per connection. A socket
    // write can block when the far end stops reading, and blocking the JS
    // thread would freeze the host's own game rather than just that peer's
    // connection.
    val writer = Executors.newSingleThreadExecutor()
  }

  override fun definition() = ModuleDefinition {
    Name("TanksLan")

    Events("onConnection", "onData", "onClose", "onError")

    AsyncFunction("start") { port: Int ->
      if (running) return@AsyncFunction boundPort()

      // Bound in two steps so SO_REUSEADDR is set while it is still defined to
      // mean something. `ServerSocket(port)` binds inside the constructor, and
      // Java documents setReuseAddress *after* a bind as undefined behaviour;
      // this order is the specified one.
      //
      // Not a bug fix, and worth saying so rather than letting the next reader
      // assume it was. Measured on a JVM rather than reasoned about: on Linux
      // SO_REUSEADDR already defaults to true for a ServerSocket, and rebinding
      // a port still held in TIME_WAIT succeeds with the flag never set at all.
      // Android is Linux, so the old form almost certainly worked -- by default
      // rather than by the line that claimed to arrange it.
      //
      // The scenario it protects is still the likeliest first use of this
      // screen: start, notice the hotspot is off, stop, turn it on, start
      // again. That path should not rest on a default nobody checked.
      val socket = ServerSocket()
      socket.reuseAddress = true
      socket.bind(InetSocketAddress(port))
      server = socket
      running = true

      acceptThread = thread(name = "tanks-lan-accept", isDaemon = true) {
        while (running) {
          val client = try {
            socket.accept()
          } catch (e: IOException) {
            // A closed listener is how stop() unblocks this call, so it is an
            // ordinary shutdown rather than something to report.
            if (running) emitError("accept", e.message ?: "accept failed")
            break
          }
          handle(client)
        }
      }
      socket.localPort
    }

    AsyncFunction("stop") {
      running = false
      for ((id, _) in conns) closeConn(id)
      try {
        server?.close()
      } catch (_: IOException) {
      }
      server = null
      acceptThread = null
    }

    Function("send") { connId: String, dataBase64: String ->
      val conn = conns[connId] ?: return@Function
      val bytes = Base64.decode(dataBase64, Base64.NO_WRAP)
      conn.writer.execute {
        try {
          conn.socket.getOutputStream().apply {
            write(bytes)
            flush()
          }
        } catch (e: IOException) {
          // The peer is gone. Tear this connection down; the match continues
          // for everyone else.
          closeConn(connId)
        }
      }
    }

    Function("close") { connId: String -> closeConn(connId) }

    Function("getIpAddress") { localAddress() }

    // Every address this device holds, unfiltered and in the platform's own
    // order. Which one to read out is decided in TypeScript -- see
    // `pickHostAddress` in @tanks/core -- because it is a judgement with a
    // table of cases, and nothing that needs a test belongs down here.
    Function("getIpCandidates") { addressCandidates() }

    Function("isSupported") { true }
  }

  private fun boundPort(): Int = server?.localPort ?: 0

  private fun handle(socket: Socket) {
    val id = "c${nextId.getAndIncrement()}"
    // Nagle batches small writes, which is precisely wrong here: input frames
    // are tiny and latency-critical, and holding them back to coalesce adds
    // exactly the delay this game is built to avoid.
    try {
      socket.tcpNoDelay = true
    } catch (_: IOException) {
    }
    conns[id] = Conn(socket)
    sendEvent("onConnection", mapOf("connId" to id))

    thread(name = "tanks-lan-$id", isDaemon = true) {
      val buf = ByteArray(8192)
      try {
        val input = socket.getInputStream()
        while (running) {
          val n = input.read(buf)
          if (n <= 0) break
          sendEvent(
            "onData",
            mapOf(
              "connId" to id,
              "data" to Base64.encodeToString(buf, 0, n, Base64.NO_WRAP),
            ),
          )
        }
      } catch (_: IOException) {
        // A phone walking out of range reads as an IOException. Not an error
        // worth surfacing -- it is the normal way a player leaves.
      } finally {
        closeConn(id)
      }
    }
  }

  private fun closeConn(id: String) {
    val conn = conns.remove(id) ?: return
    try {
      conn.socket.close()
    } catch (_: IOException) {
    }
    conn.writer.shutdown()
    sendEvent("onClose", mapOf("connId" to id))
  }

  private fun emitError(where: String, message: String) {
    sendEvent("onError", mapOf("where" to where, "message" to message))
  }

  /**
   * Every address on every interface that is up, in the platform's order.
   *
   * Reported rather than filtered. When the phone is running a hotspot the
   * usable address is on the access point interface, not on wlan0, and there is
   * no API that says which interface that is -- so the choice is a heuristic,
   * and heuristics belong where they can be tested. See `pickHostAddress`.
   */
  private fun addressCandidates(): List<Map<String, String>> {
    val out = mutableListOf<Map<String, String>>()
    try {
      for (iface in NetworkInterface.getNetworkInterfaces()) {
        if (!iface.isUp || iface.isLoopback) continue
        for (addr: InetAddress in iface.inetAddresses) {
          val host = addr.hostAddress ?: continue
          out.add(mapOf("name" to iface.name, "address" to host))
        }
      }
    } catch (_: Exception) {
      return out
    }
    return out
  }

  /**
   * First non-loopback IPv4, kept only as a fallback for an app bundle older
   * than `getIpCandidates`. It picks whatever the platform happens to list
   * first, which on a tethering phone is often the cellular interface -- an
   * address that is perfectly valid and reachable by nobody in the room.
   */
  private fun localAddress(): String? {
    try {
      for (iface in NetworkInterface.getNetworkInterfaces()) {
        if (!iface.isUp || iface.isLoopback) continue
        for (addr: InetAddress in iface.inetAddresses) {
          if (addr.isLoopbackAddress) continue
          val host = addr.hostAddress ?: continue
          // IPv6 arrives here too, and a link-local IPv6 address in a URL is
          // unreadable and unusable for someone typing it into Safari.
          if (host.contains(':')) continue
          return host
        }
      }
    } catch (_: Exception) {
      return null
    }
    return null
  }
}
