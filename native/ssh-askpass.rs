//! OpenSSH 的最小 askpass 辅助进程。
//!
//! 密码只由父进程通过短生命周期环境变量传入；本程序不显示窗口、不写文件、不记日志，
//! 也不会把密码放进命令行。离开专用模式时直接拒绝运行，避免它被误当作普通命令使用。

use std::env;
use std::io::{self, Write};

fn main() {
    if env::var_os("OPH_SSH_ASKPASS_MODE").as_deref() != Some("1".as_ref()) {
        std::process::exit(1);
    }
    let Some(secret) = env::var_os("OPH_SSH_ASKPASS_SECRET") else {
        std::process::exit(1);
    };
    if io::stdout()
        .write_all(secret.to_string_lossy().as_bytes())
        .is_err()
    {
        std::process::exit(1);
    }
}
