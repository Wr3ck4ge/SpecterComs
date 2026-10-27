use cpal::traits::{DeviceTrait, HostTrait};

fn main() {
    let host = cpal::default_host();
    let device = host.default_input_device().unwrap();
    println!("Default input config: {:?}", device.default_input_config().unwrap());
    for s in device.supported_input_configs().unwrap() {
        println!(" Supported: channels={}, min_sr={}, max_sr={}, format={:?}", s.channels(), s.min_sample_rate().0, s.max_sample_rate().0, s.sample_format());
    }
}
