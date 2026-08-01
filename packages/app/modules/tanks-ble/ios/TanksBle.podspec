Pod::Spec.new do |s|
  s.name           = 'TanksBle'
  s.version        = '0.1.0'
  s.summary        = 'Bluetooth LE transport for Tanks!'
  s.description    = 'GATT peripheral and central roles, so one phone can host a match with no internet.'
  s.author         = ''
  s.homepage       = 'https://github.com/fso5/tanks-mobile'
  s.platforms      = { :ios => '15.1' }
  s.source         = { git: 'https://github.com/fso5/tanks-mobile' }
  s.static_framework = true
  s.license        = { :type => 'MIT' }

  s.dependency 'ExpoModulesCore'
  s.frameworks = 'CoreBluetooth'

  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
    'SWIFT_COMPILATION_MODE' => 'wholemodule'
  }

  s.source_files = "**/*.{h,m,mm,swift,hpp,cpp}"
end
