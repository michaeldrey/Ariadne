fn main() {
    // On macOS, `cargo tauri dev` runs the raw binary directly, not a bundled
    // .app — which means the Info.plist we point at via tauri.conf.json only
    // gets applied in production `tauri build`. In dev, macOS TCC (Transparency,
    // Consent and Control) looks at the binary itself for privacy usage
    // descriptions. Without them, any mic/camera/etc. access hard-crashes the
    // app with an NSSpeechRecognitionUsageDescription-missing SIGABRT.
    //
    // Fix: embed Info.plist into the binary's __TEXT __info_plist section at
    // link time. TCC reads it straight off the Mach-O file.
    #[cfg(target_os = "macos")]
    {
        let manifest = std::env::var("CARGO_MANIFEST_DIR").expect("CARGO_MANIFEST_DIR");
        let plist = format!("{}/Info.plist", manifest);
        println!("cargo:rerun-if-changed=Info.plist");
        println!("cargo:rustc-link-arg=-sectcreate");
        println!("cargo:rustc-link-arg=__TEXT");
        println!("cargo:rustc-link-arg=__info_plist");
        println!("cargo:rustc-link-arg={}", plist);
    }
    tauri_build::build()
}
