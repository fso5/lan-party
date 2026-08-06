import CoreBluetooth
import ExpoModulesCore

/**
 * Bluetooth LE transport for Tanks!, iOS side.
 *
 * Mirrors the Android module exactly: the host is the GATT peripheral and
 * advertises, everyone else is a central that connects to it. See the Kotlin
 * module for why that direction is the only portable one.
 *
 * Two iOS-specific constraints shape this:
 *
 *  - iOS filters scan results by service UUID, and a peripheral advertising in
 *    the background has its UUID moved into the "overflow" area that only other
 *    iOS devices can see. Android centrals therefore cannot discover a
 *    backgrounded iPhone host. The host must be in the foreground. Fine for a
 *    game, fatal for anything else, and worth knowing before someone spends a
 *    day debugging it.
 *
 *  - The local name in an advertisement is capped hard (around 10 bytes once a
 *    128-bit service UUID is present), so the match name rides in the scan
 *    response the same way it does on Android.
 */
public class TanksBleModule: Module {

  static let serviceUUID = CBUUID(string: "6b1e4a30-9d2c-4f11-b8a7-2c5e19d4f0a1")
  static let txUUID = CBUUID(string: "6b1e4a31-9d2c-4f11-b8a7-2c5e19d4f0a1")
  static let rxUUID = CBUUID(string: "6b1e4a32-9d2c-4f11-b8a7-2c5e19d4f0a1")

  private var bridge: BleBridge?

  public func definition() -> ModuleDefinition {
    Name("TanksBle")

    Events(
      "onFrame",
      "onPeerConnected",
      "onPeerDisconnected",
      "onPeerFound",
      "onError",
      "onStateChange"
    )

    OnCreate {
      let bridge = BleBridge()
      bridge.emit = { [weak self] name, body in
        self?.sendEvent(name, body)
      }
      self.bridge = bridge
    }

    Function("isSupported") { () -> Bool in
      self.bridge?.isPoweredOn ?? false
    }

    Function("payloadSize") { () -> Int in
      self.bridge?.payloadSize ?? 20
    }

    AsyncFunction("startAdvertising") { (matchName: String) in
      self.bridge?.startAdvertising(matchName: matchName)
    }

    AsyncFunction("stopAdvertising") {
      self.bridge?.stopAdvertising()
    }

    AsyncFunction("startScanning") {
      self.bridge?.startScanning()
    }

    AsyncFunction("stopScanning") {
      self.bridge?.stopScanning()
    }

    AsyncFunction("connect") { (peerId: String) in
      self.bridge?.connect(peerId: peerId)
    }

    AsyncFunction("disconnect") { (peerId: String) in
      self.bridge?.disconnect(peerId: peerId)
    }

    Function("sendFrame") { (to: String, base64: String, ack: Bool) in
      guard let data = Data(base64Encoded: base64) else { return }
      self.bridge?.sendFrame(to: to, data: data, ack: ack)
    }

    OnDestroy {
      self.bridge?.shutdown()
      self.bridge = nil
    }
  }
}

/**
 * Both CoreBluetooth roles in one object.
 *
 * Kept separate from the Module so the delegate conformances do not collide
 * with Expo's own lifecycle methods, and so state ownership is obvious.
 */
final class BleBridge: NSObject, CBPeripheralManagerDelegate, CBCentralManagerDelegate,
  CBPeripheralDelegate
{
  var emit: ((String, [String: Any]) -> Void)?

  private var peripheralManager: CBPeripheralManager?
  private var centralManager: CBCentralManager?

  // Peripheral (host) state.
  private var txCharacteristic: CBMutableCharacteristic?
  private var subscribedCentrals: [String: CBCentral] = [:]
  private var pendingMatchName: String?

  // Central (client) state.
  private var discovered: [String: CBPeripheral] = [:]
  private var connected: [String: CBPeripheral] = [:]
  private var rxCharacteristics: [String: CBCharacteristic] = [:]

  var isPoweredOn: Bool {
    centralManager?.state == .poweredOn || peripheralManager?.state == .poweredOn
  }

  /**
   * Conservative until a real connection tells us better.
   *
   * iOS reports the negotiated size per-central via maximumUpdateValueLength.
   * We take the smallest across peers: broadcasts go to everyone, and a frame
   * sized for the best link is silently truncated on the worst -- which would
   * corrupt a snapshot rather than drop it.
   */
  var payloadSize: Int {
    var smallest = 180
    for central in subscribedCentrals.values {
      smallest = min(smallest, central.maximumUpdateValueLength)
    }
    for peripheral in connected.values {
      smallest = min(smallest, peripheral.maximumWriteValueLength(for: .withoutResponse))
    }
    return max(20, smallest)
  }

  override init() {
    super.init()
    // Created lazily on first use rather than here, so the app does not trigger
    // the system Bluetooth permission prompt merely by launching.
  }

  private func fail(_ where_: String, _ message: String) {
    emit?("onError", ["where": where_, "message": message])
  }

  // --- Peripheral --------------------------------------------------------

  func startAdvertising(matchName: String) {
    pendingMatchName = matchName
    if peripheralManager == nil {
      peripheralManager = CBPeripheralManager(delegate: self, queue: nil)
      return  // continues in peripheralManagerDidUpdateState once powered on
    }
    beginAdvertising()
  }

  private func beginAdvertising() {
    guard let manager = peripheralManager, manager.state == .poweredOn else { return }
    guard let matchName = pendingMatchName else { return }

    let tx = CBMutableCharacteristic(
      type: TanksBleModule.txUUID,
      properties: [.notify, .indicate],
      value: nil,
      permissions: [.readable]
    )
    let rx = CBMutableCharacteristic(
      type: TanksBleModule.rxUUID,
      properties: [.write, .writeWithoutResponse],
      value: nil,
      permissions: [.writeable]
    )

    let service = CBMutableService(type: TanksBleModule.serviceUUID, primary: true)
    service.characteristics = [tx, rx]

    manager.removeAllServices()
    manager.add(service)
    txCharacteristic = tx

    manager.startAdvertising([
      CBAdvertisementDataServiceUUIDsKey: [TanksBleModule.serviceUUID],
      CBAdvertisementDataLocalNameKey: matchName,
    ])
    emit?("onStateChange", ["state": "advertising", "name": matchName])
  }

  func stopAdvertising() {
    peripheralManager?.stopAdvertising()
    peripheralManager?.removeAllServices()
    txCharacteristic = nil
    subscribedCentrals.removeAll()
    pendingMatchName = nil
    emit?("onStateChange", ["state": "idle"])
  }

  func peripheralManagerDidUpdateState(_ peripheral: CBPeripheralManager) {
    switch peripheral.state {
    case .poweredOn:
      beginAdvertising()
    case .unauthorized:
      fail("peripheral", "Bluetooth permission denied")
    case .poweredOff:
      fail("peripheral", "Bluetooth is off")
    case .unsupported:
      fail("peripheral", "this device does not support Bluetooth LE")
    default:
      break
    }
  }

  func peripheralManager(
    _ peripheral: CBPeripheralManager,
    central: CBCentral,
    didSubscribeTo characteristic: CBCharacteristic
  ) {
    let id = central.identifier.uuidString
    subscribedCentrals[id] = central
    emit?("onPeerConnected", ["peerId": id, "name": id])
    emit?("onStateChange", ["state": "mtu", "payload": payloadSize])
  }

  func peripheralManager(
    _ peripheral: CBPeripheralManager,
    central: CBCentral,
    didUnsubscribeFrom characteristic: CBCharacteristic
  ) {
    let id = central.identifier.uuidString
    subscribedCentrals.removeValue(forKey: id)
    emit?("onPeerDisconnected", ["peerId": id, "reason": "unsubscribed"])
  }

  func peripheralManager(
    _ peripheral: CBPeripheralManager,
    didReceiveWrite requests: [CBATTRequest]
  ) {
    for request in requests {
      if request.characteristic.uuid == TanksBleModule.rxUUID, let value = request.value {
        emit?(
          "onFrame",
          [
            "peerId": request.central.identifier.uuidString,
            "frame": value.base64EncodedString(),
          ])
      }
    }
    // Responding to only the first request acknowledges the whole batch, which
    // is what CoreBluetooth expects.
    if let first = requests.first {
      peripheral.respond(to: first, withResult: .success)
    }
  }

  // --- Central -----------------------------------------------------------

  func startScanning() {
    if centralManager == nil {
      centralManager = CBCentralManager(delegate: self, queue: nil)
      return  // continues in centralManagerDidUpdateState
    }
    guard let manager = centralManager, manager.state == .poweredOn else { return }
    // Filtering by service UUID is required, not an optimisation: iOS will not
    // return backgrounded peripherals for an unfiltered scan.
    manager.scanForPeripherals(
      withServices: [TanksBleModule.serviceUUID],
      options: [CBCentralManagerScanOptionAllowDuplicatesKey: false]
    )
    emit?("onStateChange", ["state": "scanning"])
  }

  func stopScanning() {
    centralManager?.stopScan()
  }

  func centralManagerDidUpdateState(_ central: CBCentralManager) {
    switch central.state {
    case .poweredOn:
      startScanning()
    case .unauthorized:
      fail("central", "Bluetooth permission denied")
    case .poweredOff:
      fail("central", "Bluetooth is off")
    default:
      break
    }
  }

  func centralManager(
    _ central: CBCentralManager,
    didDiscover peripheral: CBPeripheral,
    advertisementData: [String: Any],
    rssi RSSI: NSNumber
  ) {
    let id = peripheral.identifier.uuidString
    discovered[id] = peripheral
    let name = (advertisementData[CBAdvertisementDataLocalNameKey] as? String) ?? peripheral.name
    emit?("onPeerFound", ["peerId": id, "name": name ?? id, "rssi": RSSI.intValue])
  }

  func connect(peerId: String) {
    guard let manager = centralManager else {
      fail("connect", "not scanning yet")
      return
    }
    guard let peripheral = discovered[peerId] else {
      fail("connect", "unknown peer \(peerId)")
      return
    }
    // Hold a strong reference before connecting: CoreBluetooth does not retain
    // the peripheral, and a released one silently never connects.
    connected[peerId] = peripheral
    peripheral.delegate = self
    manager.connect(peripheral, options: nil)
  }

  func disconnect(peerId: String) {
    if let peripheral = connected.removeValue(forKey: peerId) {
      centralManager?.cancelPeripheralConnection(peripheral)
    }
    rxCharacteristics.removeValue(forKey: peerId)
  }

  func centralManager(_ central: CBCentralManager, didConnect peripheral: CBPeripheral) {
    peripheral.discoverServices([TanksBleModule.serviceUUID])
  }

  func centralManager(
    _ central: CBCentralManager,
    didFailToConnect peripheral: CBPeripheral,
    error: Error?
  ) {
    let id = peripheral.identifier.uuidString
    connected.removeValue(forKey: id)
    fail("connect", error?.localizedDescription ?? "could not connect")
    // An onError does not settle a pending join -- BleTransport.join waits for
    // onPeerConnected or onPeerDisconnected and nothing else. Without this the
    // caller sat through the full ten second timeout and then got the generic
    // "no answer" message, throwing away the reason CoreBluetooth just handed
    // us. Android reports its status code here for the same reason.
    let reason = error?.localizedDescription ?? "no reason given"
    emit?("onPeerDisconnected", ["peerId": id, "reason": "connect failed (\(reason))"])
  }

  func centralManager(
    _ central: CBCentralManager,
    didDisconnectPeripheral peripheral: CBPeripheral,
    error: Error?
  ) {
    let id = peripheral.identifier.uuidString
    connected.removeValue(forKey: id)
    rxCharacteristics.removeValue(forKey: id)
    emit?(
      "onPeerDisconnected",
      ["peerId": id, "reason": error?.localizedDescription ?? "disconnected"])
  }

  func peripheral(_ peripheral: CBPeripheral, didDiscoverServices error: Error?) {
    guard let service = peripheral.services?.first(where: { $0.uuid == TanksBleModule.serviceUUID })
    else {
      fail("discover", "peer has no Tanks service")
      // Drop the link rather than leaving it up and useless. The peripheral is
      // connected but can never carry anything, and without this nothing ever
      // removes it -- so JS gets an error it may only log, then silence.
      // Cancelling produces didDisconnectPeripheral, which settles the join.
      centralManager?.cancelPeripheralConnection(peripheral)
      return
    }
    peripheral.discoverCharacteristics(
      [TanksBleModule.txUUID, TanksBleModule.rxUUID], for: service)
  }

  func peripheral(
    _ peripheral: CBPeripheral,
    didDiscoverCharacteristicsFor service: CBService,
    error: Error?
  ) {
    let id = peripheral.identifier.uuidString
    var tx: CBCharacteristic?
    for characteristic in service.characteristics ?? [] {
      if characteristic.uuid == TanksBleModule.rxUUID {
        rxCharacteristics[id] = characteristic
      } else if characteristic.uuid == TanksBleModule.txUUID {
        tx = characteristic
        // Unlike Android there is no CCCD to write by hand; iOS handles the
        // descriptor as part of this call.
        peripheral.setNotifyValue(true, for: characteristic)
      }
    }

    // onPeerConnected is what resolves a join, and Transport.join promises that
    // a resolved join means a send will go somewhere. This used to announce the
    // peer whatever the peripheral turned out to carry: with TX missing nothing
    // is ever received, with RX missing nothing can be sent, and either way the
    // match sat on a connection that looked fine and did nothing. Android
    // checks the same two before announcing.
    guard tx != nil, rxCharacteristics[id] != nil else {
      fail("discover", "peer is missing a Tanks characteristic")
      centralManager?.cancelPeripheralConnection(peripheral)
      return
    }

    emit?("onPeerConnected", ["peerId": id, "name": peripheral.name ?? id])
    emit?("onStateChange", ["state": "mtu", "payload": payloadSize])
  }

  func peripheral(
    _ peripheral: CBPeripheral,
    didUpdateValueFor characteristic: CBCharacteristic,
    error: Error?
  ) {
    guard characteristic.uuid == TanksBleModule.txUUID, let value = characteristic.value else {
      return
    }
    emit?(
      "onFrame",
      [
        "peerId": peripheral.identifier.uuidString,
        "frame": value.base64EncodedString(),
      ])
  }

  // --- Sending -----------------------------------------------------------

  func sendFrame(to: String, data: Data, ack: Bool) {
    // Host path: notify the subscribed central.
    if let central = subscribedCentrals[to], let tx = txCharacteristic,
      let manager = peripheralManager
    {
      // updateValue returns false when the transmit queue is full. Snapshots are
      // deliberately droppable -- a fresher one follows in 66ms -- so a dropped
      // notification is correct behaviour rather than something to buffer.
      let sent = manager.updateValue(data, for: tx, onSubscribedCentrals: [central])
      if !sent && ack {
        fail("send", "transmit queue full, reliable frame dropped")
      }
      return
    }

    // Client path: write to the host's RX characteristic.
    if let peripheral = connected[to], let rx = rxCharacteristics[to] {
      peripheral.writeValue(data, for: rx, type: ack ? .withResponse : .withoutResponse)
      return
    }

    fail("send", "no route to \(to)")
  }

  func shutdown() {
    stopScanning()
    stopAdvertising()
    for peripheral in connected.values {
      centralManager?.cancelPeripheralConnection(peripheral)
    }
    connected.removeAll()
    discovered.removeAll()
    rxCharacteristics.removeAll()
  }
}
