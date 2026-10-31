{ pkgs, multiverse, ... }:
{
  devenv.warnOnNewVersion = false;
  dotenv.disableHint = true;
  packages = with pkgs; [ git corepack cloudflared docker-client actionlint ]
    ++ lib.optionals stdenv.isLinux [
      pkg-config
      gcc
      glib
      gtk3
      webkitgtk_4_1
      libsoup_3
      openssl
      librsvg
      patchelf
      xdg-utils
      dbus
      gst_all_1.gstreamer
      gst_all_1.gst-plugins-base
      gst_all_1.gst-plugins-good
    ];
  languages.javascript = {
    enable = true;
    lsp.enable = false;
    package = multiverse.nodejs_26."26.12.1";
  };
  languages.rust = {
    enable = true;
    channel = "stable";
    version = "1.99.0";
    components = [ "rustc" "cargo" "rust-std" "rustfmt" "clippy" ];
  };
  env.LD_LIBRARY_PATH = pkgs.lib.optionalString pkgs.stdenv.isLinux
    (pkgs.lib.makeLibraryPath [ pkgs.webkitgtk_4_1 pkgs.gtk3 pkgs.openssl ]);
  env.GST_PLUGIN_SYSTEM_PATH_1_0 = pkgs.lib.optionalString pkgs.stdenv.isLinux
    (pkgs.lib.makeSearchPath "lib/gstreamer-1.0" [
      pkgs.gst_all_1.gstreamer pkgs.gst_all_1.gst-plugins-base pkgs.gst_all_1.gst-plugins-good
    ]);

  profiles.test.module = {
    packages = pkgs.lib.optionals pkgs.stdenv.isLinux [ pkgs.xorg-server pkgs.chromium pkgs.dbus pkgs.gnome-keyring pkgs.pulseaudio pkgs.xdotool pkgs.xclip ];
    env.E2E_CHROMIUM = pkgs.lib.optionalString pkgs.stdenv.isLinux "${pkgs.chromium}/bin/chromium";
  };

  profiles.android.module = { config, ... }: {
    env.JAVA_HOME = "${pkgs.jdk21}";
    # Keep the deprecated alias consistent when a host or CI exports it.
    env.ANDROID_SDK_ROOT = config.env.ANDROID_HOME;
    env.NDK_HOME = "${config.env.ANDROID_HOME}/ndk/28.2.13676358";
    languages.rust.targets = [
      "aarch64-linux-android"
      "armv7-linux-androideabi"
      "i686-linux-android"
      "x86_64-linux-android"
    ];
    android = {
      enable = true;
      # The Tauri Android library uses 36; the app targets 37. Nix SDKs
      # cannot download a missing platform during a Gradle build.
      platforms.version = [ "36" "37" ];
      buildTools.version = [ "36.0.0" ];
      ndk.enable = true;
      ndk.version = [ "28.2.13676358" ];
      systemImages.enable = false;
      emulator.enable = false;
    };
  };
  profiles.ios.module = {
    languages.rust.targets = [ "aarch64-apple-ios" "aarch64-apple-ios-sim" "x86_64-apple-ios" ];
  };
  profiles.emulator = {
    extends = [ "android" ];
    module = {
      # The emulator ships a C++ runtime that must not load WebKit's libraries.
      env.LD_LIBRARY_PATH = pkgs.lib.mkForce "";
      # Keep the emulator image separate from the SDK used to build the app.
      android = {
        platforms.version = pkgs.lib.mkForce [ "36" ];
        abis = [ "x86_64" ];
        systemImageTypes = [ "google_apis" ];
        systemImages.enable = true;
        emulator.enable = true;
      };
    };
  };
}
