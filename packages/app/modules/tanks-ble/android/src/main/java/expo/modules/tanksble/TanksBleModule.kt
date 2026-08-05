package expo.modules.tanksble

import android.annotation.SuppressLint
import android.bluetooth.BluetoothAdapter
import android.bluetooth.BluetoothDevice
import android.bluetooth.BluetoothGatt
import android.bluetooth.BluetoothGattCallback
import android.bluetooth.BluetoothGattCharacteristic
import android.bluetooth.BluetoothGattDescriptor
import android.bluetooth.BluetoothGattServer
import android.bluetooth.BluetoothGattServerCallback
import android.bluetooth.BluetoothGattService
import android.bluetooth.BluetoothManager
import android.bluetooth.BluetoothProfile
import android.bluetooth.le.AdvertiseCallback
import android.bluetooth.le.AdvertiseData
import android.bluetooth.le.AdvertiseSettings
import android.bluetooth.le.BluetoothLeAdvertiser
import android.bluetooth.le.ScanCallback
import android.bluetooth.le.ScanFilter
import android.bluetooth.le.ScanResult
import android.bluetooth.le.ScanSettings
import android.content.Context
import android.os.Build
import android.os.ParcelUuid
import android.util.Base64
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap

/**
 * Bluetooth LE transport for Tanks!.
 *
 * The host is the GATT **peripheral** and advertises; everyone else is a
 * central that connects to it. That is the inverse of the intuitive
 * arrangement and it is the only one that works cross-platform -- a central can
 * only reach peripherals it has connected to, so clients-as-peripherals could
 * never be discovered as one match.
 *
 * Reliability is not implemented here. BLE already has two delivery modes and
 * they map exactly onto what the protocol needs:
 *
 *   reliable   -> indication (peripheral) / write-with-response (central)
 *   unreliable -> notification            / write-without-response
 *
 * The JS side chooses per frame. Snapshots go unreliable because a lost one is
 * superseded 66ms later; shell spawns go reliable because a client that misses
 * one has an invisible shell flying at it.
 *
 * Permissions are the caller's problem -- the app requests BLUETOOTH_SCAN,
 * BLUETOOTH_ADVERTISE and BLUETOOTH_CONNECT before touching any of this. Every
 * entry point is guarded so a denied permission surfaces as an error event
 * rather than a SecurityException crash.
 */
class TanksBleModule : Module() {

  companion object {
    val SERVICE_UUID: UUID = UUID.fromString("6b1e4a30-9d2c-4f11-b8a7-2c5e19d4f0a1")
    val TX_UUID: UUID = UUID.fromString("6b1e4a31-9d2c-4f11-b8a7-2c5e19d4f0a1")
    val RX_UUID: UUID = UUID.fromString("6b1e4a32-9d2c-4f11-b8a7-2c5e19d4f0a1")

    /** Client Characteristic Configuration -- the standard notify-enable descriptor. */
    val CCCD_UUID: UUID = UUID.fromString("00002902-0000-1000-8000-00805f9b34fb")

    /**
     * MTU we ask for. Android will grant far more, but a cross-platform match is
     * limited by whichever end is worse and iOS lands around 185. Asking for 247
     * and taking what we get keeps the negotiation honest.
     */
    const val DESIRED_MTU = 247

    /** ATT overhead: 3 bytes of the MTU are the opcode and handle. */
    const val ATT_OVERHEAD = 3
  }

  private val context: Context
    get() = requireNotNull(appContext.reactContext)

  private val manager: BluetoothManager?
    get() = context.getSystemService(Context.BLUETOOTH_SERVICE) as? BluetoothManager

  private val adapter: BluetoothAdapter?
    get() = manager?.adapter

  // --- Peripheral (host) state -------------------------------------------
  private var advertiser: BluetoothLeAdvertiser? = null
  private var gattServer: BluetoothGattServer? = null
  private var txCharacteristic: BluetoothGattCharacteristic? = null
  private val subscribers = ConcurrentHashMap<String, BluetoothDevice>()

  // --- Central (client) state --------------------------------------------
  private var scanning = false
  private val connections = ConcurrentHashMap<String, BluetoothGatt>()
  private val rxCharacteristics = ConcurrentHashMap<String, BluetoothGattCharacteristic>()

  /**
   * Devices we have asked to connect and not yet heard succeed.
   *
   * Needed to tell apart the two ways a device can reach the disconnected
   * callback without ever having been in `connections`: a connect attempt that
   * failed, which JS is waiting to hear about, and a deliberate `disconnect()`
   * that already announced itself. Without this distinction the code either
   * stays silent on a failed connect (what it used to do) or announces every
   * intentional departure twice.
   */
  private val connecting = ConcurrentHashMap.newKeySet<String>()

  /**
   * Negotiated payload, shared by both roles. Starts at the BLE default (23)
   * and grows once a connection negotiates up. The JS side reads this to size
   * its frames, so it must never overstate what a write can carry -- an
   * oversized write is silently truncated rather than rejected, which would
   * corrupt a snapshot instead of dropping it.
   */
  @Volatile
  private var negotiatedPayload = 20

  override fun definition() = ModuleDefinition {
    Name("TanksBle")

    Events(
      "onFrame",
      "onPeerConnected",
      "onPeerDisconnected",
      "onPeerFound",
      "onError",
      "onStateChange",
    )

    Function("isSupported") {
      adapter?.isEnabled == true && adapter?.bluetoothLeAdvertiser != null
    }

    Function("payloadSize") { negotiatedPayload }

    AsyncFunction("startAdvertising") { matchName: String ->
      startAdvertising(matchName)
    }

    AsyncFunction("stopAdvertising") { stopAdvertising() }

    AsyncFunction("startScanning") { startScanning() }

    AsyncFunction("stopScanning") { stopScanning() }

    AsyncFunction("connect") { peerId: String -> connect(peerId) }

    AsyncFunction("disconnect") { peerId: String -> disconnect(peerId) }

    Function("sendFrame") { to: String, base64: String, ack: Boolean ->
      sendFrame(to, Base64.decode(base64, Base64.NO_WRAP), ack)
    }

    OnDestroy { shutdown() }
  }

  private fun fail(where: String, err: Throwable) {
    sendEvent("onError", mapOf("where" to where, "message" to (err.message ?: err.toString())))
  }

  // --- Peripheral --------------------------------------------------------

  @SuppressLint("MissingPermission")
  private fun startAdvertising(matchName: String) {
    try {
      val mgr = manager ?: throw IllegalStateException("no bluetooth manager")
      val adv = adapter?.bluetoothLeAdvertiser
        ?: throw IllegalStateException("this device cannot advertise (no peripheral role)")

      val server = mgr.openGattServer(context, serverCallback)
        ?: throw IllegalStateException("could not open GATT server")
      gattServer = server

      // TX: host -> client. Both NOTIFY and INDICATE so the JS side can pick
      // per frame; the CCCD is what lets a client subscribe at all.
      val tx = BluetoothGattCharacteristic(
        TX_UUID,
        BluetoothGattCharacteristic.PROPERTY_NOTIFY or BluetoothGattCharacteristic.PROPERTY_INDICATE,
        BluetoothGattCharacteristic.PERMISSION_READ,
      )
      tx.addDescriptor(
        BluetoothGattDescriptor(
          CCCD_UUID,
          BluetoothGattDescriptor.PERMISSION_READ or BluetoothGattDescriptor.PERMISSION_WRITE,
        ),
      )

      // RX: client -> host. Both write types, again so the sender chooses.
      val rx = BluetoothGattCharacteristic(
        RX_UUID,
        BluetoothGattCharacteristic.PROPERTY_WRITE or
          BluetoothGattCharacteristic.PROPERTY_WRITE_NO_RESPONSE,
        BluetoothGattCharacteristic.PERMISSION_WRITE,
      )

      val service = BluetoothGattService(SERVICE_UUID, BluetoothGattService.SERVICE_TYPE_PRIMARY)
      service.addCharacteristic(tx)
      service.addCharacteristic(rx)
      server.addService(service)
      txCharacteristic = tx

      val settings = AdvertiseSettings.Builder()
        // A game host is on screen and plugged into a player's attention, so
        // spend the battery on a fast connection rather than conserving it.
        .setAdvertiseMode(AdvertiseSettings.ADVERTISE_MODE_LOW_LATENCY)
        .setTxPowerLevel(AdvertiseSettings.ADVERTISE_TX_POWER_HIGH)
        .setConnectable(true)
        .setTimeout(0)
        .build()

      // The advertisement packet is only 31 bytes and a 128-bit service UUID
      // eats 16 of them, so the match name goes in the scan response rather
      // than crowding out the UUID clients filter on.
      val data = AdvertiseData.Builder()
        .setIncludeDeviceName(false)
        .addServiceUuid(ParcelUuid(SERVICE_UUID))
        .build()

      val scanResponse = AdvertiseData.Builder()
        .addServiceData(ParcelUuid(SERVICE_UUID), matchName.take(20).toByteArray(Charsets.UTF_8))
        .build()

      adv.startAdvertising(settings, data, scanResponse, advertiseCallback)
      advertiser = adv
      sendEvent("onStateChange", mapOf("state" to "advertising", "name" to matchName))
    } catch (e: Throwable) {
      fail("startAdvertising", e)
    }
  }

  @SuppressLint("MissingPermission")
  private fun stopAdvertising() {
    try {
      advertiser?.stopAdvertising(advertiseCallback)
      advertiser = null
      gattServer?.close()
      gattServer = null
      txCharacteristic = null
      subscribers.clear()
      sendEvent("onStateChange", mapOf("state" to "idle"))
    } catch (e: Throwable) {
      fail("stopAdvertising", e)
    }
  }

  private val advertiseCallback = object : AdvertiseCallback() {
    override fun onStartFailure(errorCode: Int) {
      val reason = when (errorCode) {
        ADVERTISE_FAILED_DATA_TOO_LARGE -> "advertisement payload too large"
        ADVERTISE_FAILED_TOO_MANY_ADVERTISERS -> "too many advertisers on this device"
        ADVERTISE_FAILED_ALREADY_STARTED -> "already advertising"
        ADVERTISE_FAILED_INTERNAL_ERROR -> "internal bluetooth error"
        ADVERTISE_FAILED_FEATURE_UNSUPPORTED -> "this device cannot act as a peripheral"
        else -> "advertising failed ($errorCode)"
      }
      sendEvent("onError", mapOf("where" to "advertise", "message" to reason))
    }
  }

  private val serverCallback = object : BluetoothGattServerCallback() {
    override fun onConnectionStateChange(device: BluetoothDevice, status: Int, newState: Int) {
      val id = device.address
      if (newState == BluetoothProfile.STATE_CONNECTED) {
        subscribers[id] = device
        sendEvent("onPeerConnected", mapOf("peerId" to id, "name" to (safeName(device) ?: id)))
      } else if (newState == BluetoothProfile.STATE_DISCONNECTED) {
        // Same rule as the central side: announce a departure only for someone
        // who was actually here. A device can reach DISCONNECTED without ever
        // having been a subscriber -- a connection that drops before it
        // subscribes -- and core should not be told a player left who never
        // arrived.
        if (subscribers.remove(id) != null) {
          sendEvent("onPeerDisconnected", mapOf("peerId" to id, "reason" to "status $status"))
        }
      }
    }

    override fun onMtuChanged(device: BluetoothDevice, mtu: Int) {
      // Take the smallest MTU any peer negotiated: broadcasts go to everyone,
      // so a frame sized for the best link would be truncated on the worst.
      val payload = mtu - ATT_OVERHEAD
      if (payload < negotiatedPayload || negotiatedPayload == 20) {
        negotiatedPayload = payload
        sendEvent("onStateChange", mapOf("state" to "mtu", "payload" to payload))
      }
    }

    @SuppressLint("MissingPermission")
    override fun onCharacteristicWriteRequest(
      device: BluetoothDevice,
      requestId: Int,
      characteristic: BluetoothGattCharacteristic,
      preparedWrite: Boolean,
      responseNeeded: Boolean,
      offset: Int,
      value: ByteArray,
    ) {
      if (characteristic.uuid == RX_UUID) {
        emitFrame(device.address, value)
      }
      if (responseNeeded) {
        gattServer?.sendResponse(device, requestId, BluetoothGatt.GATT_SUCCESS, offset, null)
      }
    }

    @SuppressLint("MissingPermission")
    override fun onDescriptorWriteRequest(
      device: BluetoothDevice,
      requestId: Int,
      descriptor: BluetoothGattDescriptor,
      preparedWrite: Boolean,
      responseNeeded: Boolean,
      offset: Int,
      value: ByteArray,
    ) {
      // A client enabling notifications is what actually makes it reachable.
      if (descriptor.uuid == CCCD_UUID) subscribers[device.address] = device
      if (responseNeeded) {
        gattServer?.sendResponse(device, requestId, BluetoothGatt.GATT_SUCCESS, offset, null)
      }
    }
  }

  // --- Central -----------------------------------------------------------

  @SuppressLint("MissingPermission")
  private fun startScanning() {
    try {
      val scanner = adapter?.bluetoothLeScanner
        ?: throw IllegalStateException("bluetooth is off or unavailable")
      if (scanning) return

      // Filtering by service UUID in the scan filter rather than in our own
      // callback matters: it lets the chipset do the filtering, which is both
      // far cheaper on battery and required for scans to work when the screen
      // is off.
      val filters = listOf(
        ScanFilter.Builder().setServiceUuid(ParcelUuid(SERVICE_UUID)).build(),
      )
      val settings = ScanSettings.Builder()
        .setScanMode(ScanSettings.SCAN_MODE_LOW_LATENCY)
        .build()

      scanner.startScan(filters, settings, scanCallback)
      scanning = true
      sendEvent("onStateChange", mapOf("state" to "scanning"))
    } catch (e: Throwable) {
      fail("startScanning", e)
    }
  }

  @SuppressLint("MissingPermission")
  private fun stopScanning() {
    try {
      if (!scanning) return
      adapter?.bluetoothLeScanner?.stopScan(scanCallback)
      scanning = false
    } catch (e: Throwable) {
      fail("stopScanning", e)
    }
  }

  private val scanCallback = object : ScanCallback() {
    override fun onScanResult(callbackType: Int, result: ScanResult) {
      val device = result.device
      val serviceData = result.scanRecord?.getServiceData(ParcelUuid(SERVICE_UUID))
      val matchName = serviceData?.toString(Charsets.UTF_8)
      sendEvent(
        "onPeerFound",
        mapOf(
          "peerId" to device.address,
          "name" to (matchName ?: safeName(device) ?: device.address),
          "rssi" to result.rssi,
        ),
      )
    }

    override fun onScanFailed(errorCode: Int) {
      sendEvent("onError", mapOf("where" to "scan", "message" to "scan failed ($errorCode)"))
    }
  }

  @SuppressLint("MissingPermission")
  private fun connect(peerId: String) {
    try {
      val device = adapter?.getRemoteDevice(peerId)
        ?: throw IllegalStateException("unknown device $peerId")
      // Recorded before the call, so a stack that fails fast cannot deliver the
      // failure callback before we are in a position to recognise it.
      connecting.add(peerId)
      // TRANSPORT_LE explicitly: without it Android may try BR/EDR on dual-mode
      // devices and fail in ways that look like the peer is absent.
      device.connectGatt(context, false, gattCallback, BluetoothDevice.TRANSPORT_LE)
    } catch (e: Throwable) {
      connecting.remove(peerId)
      fail("connect", e)
    }
  }

  /**
   * Leaving on purpose, and saying so.
   *
   * The JS side learns a peer is gone from `onPeerDisconnected` and from
   * nothing else -- `bleAdapter` drops it from `live` and tells core there. So
   * a departure that emits no event leaves core sending to somebody who is not
   * there, and leaves `live` overstating the room, which pins the frame size to
   * the 20-byte floor for the rest of the match.
   *
   * `close()` immediately after `disconnect()` is widely held to suppress the
   * state-change callback, and I have no radio here to settle it. So this does
   * not depend on the answer: the event is emitted here, and the callback path
   * below only emits when it was the one that removed the entry. Exactly one
   * event per departure whichever way the platform behaves, which is the point
   * -- the previous shape could emit none or two depending on it.
   */
  @SuppressLint("MissingPermission")
  private fun disconnect(peerId: String) {
    try {
      val gatt = connections.remove(peerId)
      rxCharacteristics.remove(peerId)
      if (gatt != null) {
        gatt.disconnect()
        gatt.close()
        sendEvent("onPeerDisconnected", mapOf("peerId" to peerId, "reason" to "left"))
      }
    } catch (e: Throwable) {
      fail("disconnect", e)
    }
  }

  private val gattCallback = object : BluetoothGattCallback() {
    @SuppressLint("MissingPermission")
    override fun onConnectionStateChange(gatt: BluetoothGatt, status: Int, newState: Int) {
      val id = gatt.device.address
      if (newState == BluetoothProfile.STATE_CONNECTED) {
        connections[id] = gatt
        // Still not "connected" as far as JS is concerned -- that waits for
        // service discovery below -- but it is no longer a candidate for the
        // failed-connect report, because from here a drop is a real departure.
        connecting.remove(id)
        // Ask for a bigger MTU before discovering services: a larger MTU makes
        // every subsequent write cheaper, and doing it after discovery means
        // renegotiating mid-match.
        gatt.requestMtu(DESIRED_MTU)
      } else if (newState == BluetoothProfile.STATE_DISCONNECTED) {
        // Only the remover announces it. If `disconnect()` already took this
        // entry out and said so, this callback -- should the platform deliver
        // it after close() -- must not say it again.
        val wasLive = connections.remove(id) != null
        val wasConnecting = connecting.remove(id)
        rxCharacteristics.remove(id)
        gatt.close()
        if (wasLive) {
          sendEvent("onPeerDisconnected", mapOf("peerId" to id, "reason" to "status $status"))
        } else if (wasConnecting) {
          // A connect that never came up. This used to emit nothing at all --
          // the entry was never in `connections`, so the guard against
          // double-announcing a departure also swallowed every failed connect,
          // and JS sat waiting for a peer that was never going to arrive.
          //
          // This is the path a full host puts people on: status 133 is the
          // usual catch-all and is what an Android stack already holding as
          // many links as it supports returns. Saying so immediately is the
          // difference between "it didn't work" and ten seconds of nothing.
          sendEvent(
            "onPeerDisconnected",
            mapOf("peerId" to id, "reason" to "connect failed (status $status)"),
          )
        }
      }
    }

    @SuppressLint("MissingPermission")
    override fun onMtuChanged(gatt: BluetoothGatt, mtu: Int, status: Int) {
      negotiatedPayload = mtu - ATT_OVERHEAD
      sendEvent("onStateChange", mapOf("state" to "mtu", "payload" to negotiatedPayload))
      gatt.discoverServices()
    }

    @SuppressLint("MissingPermission")
    override fun onServicesDiscovered(gatt: BluetoothGatt, status: Int) {
      val id = gatt.device.address
      val service = gatt.getService(SERVICE_UUID)
      if (service == null) {
        sendEvent("onError", mapOf("where" to "discover", "message" to "peer has no Tanks service"))
        gatt.disconnect()
        return
      }

      service.getCharacteristic(RX_UUID)?.let { rxCharacteristics[id] = it }

      val tx = service.getCharacteristic(TX_UUID)
      if (tx == null) {
        sendEvent("onError", mapOf("where" to "discover", "message" to "peer has no TX characteristic"))
        // Disconnect, as the missing-service branch above does. Returning here
        // left a live GATT link in `connections` that could never deliver a
        // notification, and -- because nothing ever removed it -- no
        // disconnected event either. An onError JS may only log, and then
        // silence. Dropping the link turns it into a reported failure.
        gatt.disconnect()
        return
      }

      // Two steps, both required. setCharacteristicNotification only tells the
      // local stack to deliver them; writing the CCCD is what tells the remote
      // device to actually send them. Omitting the second is the classic way to
      // end up with a connection that looks fine and delivers nothing.
      gatt.setCharacteristicNotification(tx, true)
      val cccd = tx.getDescriptor(CCCD_UUID)
      if (cccd != null) {
        val enable = BluetoothGattDescriptor.ENABLE_NOTIFICATION_VALUE
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
          gatt.writeDescriptor(cccd, enable)
        } else {
          @Suppress("DEPRECATION")
          cccd.value = enable
          @Suppress("DEPRECATION")
          gatt.writeDescriptor(cccd)
        }
      }

      sendEvent("onPeerConnected", mapOf("peerId" to id, "name" to (safeName(gatt.device) ?: id)))
    }

    override fun onCharacteristicChanged(
      gatt: BluetoothGatt,
      characteristic: BluetoothGattCharacteristic,
      value: ByteArray,
    ) {
      if (characteristic.uuid == TX_UUID) emitFrame(gatt.device.address, value)
    }

    @Deprecated("Pre-Tiramisu callback; the platform still uses it below API 33.")
    @Suppress("DEPRECATION")
    override fun onCharacteristicChanged(
      gatt: BluetoothGatt,
      characteristic: BluetoothGattCharacteristic,
    ) {
      if (characteristic.uuid == TX_UUID) {
        characteristic.value?.let { emitFrame(gatt.device.address, it) }
      }
    }
  }

  // --- Sending -----------------------------------------------------------

  @SuppressLint("MissingPermission")
  private fun sendFrame(to: String, bytes: ByteArray, ack: Boolean) {
    try {
      // Host path: notify the subscribed central. ack selects indication, which
      // the remote confirms, over a plain notification which it does not.
      val device = subscribers[to]
      val tx = txCharacteristic
      val server = gattServer
      if (device != null && tx != null && server != null) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
          server.notifyCharacteristicChanged(device, tx, ack, bytes)
        } else {
          @Suppress("DEPRECATION")
          tx.value = bytes
          @Suppress("DEPRECATION")
          server.notifyCharacteristicChanged(device, tx, ack)
        }
        return
      }

      // Client path: write to the host's RX characteristic.
      val gatt = connections[to]
      val rx = rxCharacteristics[to]
      if (gatt != null && rx != null) {
        val writeType = if (ack) {
          BluetoothGattCharacteristic.WRITE_TYPE_DEFAULT
        } else {
          BluetoothGattCharacteristic.WRITE_TYPE_NO_RESPONSE
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
          gatt.writeCharacteristic(rx, bytes, writeType)
        } else {
          @Suppress("DEPRECATION")
          rx.writeType = writeType
          @Suppress("DEPRECATION")
          rx.value = bytes
          @Suppress("DEPRECATION")
          gatt.writeCharacteristic(rx)
        }
        return
      }

      sendEvent("onError", mapOf("where" to "send", "message" to "no route to $to"))
    } catch (e: Throwable) {
      fail("sendFrame", e)
    }
  }

  private fun emitFrame(from: String, bytes: ByteArray) {
    sendEvent(
      "onFrame",
      mapOf("peerId" to from, "frame" to Base64.encodeToString(bytes, Base64.NO_WRAP)),
    )
  }

  @SuppressLint("MissingPermission")
  private fun safeName(device: BluetoothDevice): String? = try {
    device.name
  } catch (_: SecurityException) {
    // BLUETOOTH_CONNECT not granted. The address still identifies the peer, so
    // this is cosmetic rather than fatal.
    null
  }

  private fun shutdown() {
    stopScanning()
    stopAdvertising()
    connections.values.forEach {
      try {
        it.close()
      } catch (_: Throwable) {
      }
    }
    connections.clear()
    rxCharacteristics.clear()
  }
}
