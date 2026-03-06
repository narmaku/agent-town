"""
Tiny PTY bridge: spawns a command inside a pseudo-terminal and relays
stdin/stdout as raw bytes.

Usage: python3 pty-helper.py <cols> <rows> <command> [args...]

Resize: send a JSON line to stdin: {"type":"resize","cols":N,"rows":N}
All other stdin data is forwarded to the PTY as-is.
"""
import sys, os, pty, select, signal, struct, fcntl, termios, json

def set_winsize(fd, cols, rows):
    winsize = struct.pack("HHHH", rows, cols, 0, 0)
    fcntl.ioctl(fd, termios.TIOCSWINSZ, winsize)

def main():
    if len(sys.argv) < 4:
        sys.exit("Usage: pty-helper.py <cols> <rows> <command> [args...]")

    cols, rows = int(sys.argv[1]), int(sys.argv[2])
    cmd = sys.argv[3:]

    pid, master_fd = pty.fork()

    if pid == 0:
        os.execvp(cmd[0], cmd)
        sys.exit(1)

    set_winsize(master_fd, cols, rows)

    stdin_fd = sys.stdin.fileno()
    stdout_fd = sys.stdout.fileno()
    flags = fcntl.fcntl(stdin_fd, fcntl.F_GETFL)
    fcntl.fcntl(stdin_fd, fcntl.F_SETFL, flags | os.O_NONBLOCK)

    stdin_buf = b""

    try:
        while True:
            rlist, _, _ = select.select([master_fd, stdin_fd], [], [], 0.02)

            for fd in rlist:
                if fd == master_fd:
                    try:
                        data = os.read(master_fd, 65536)
                        if not data:
                            return
                        os.write(stdout_fd, data)
                    except OSError:
                        return

                elif fd == stdin_fd:
                    try:
                        data = os.read(stdin_fd, 65536)
                        if not data:
                            return

                        stdin_buf += data
                        while b"\n" in stdin_buf:
                            line, stdin_buf = stdin_buf.split(b"\n", 1)
                            line_str = line.decode("utf-8", errors="ignore").strip()
                            if line_str.startswith('{"type":"resize"'):
                                try:
                                    msg = json.loads(line_str)
                                    set_winsize(master_fd, msg["cols"], msg["rows"])
                                    os.kill(pid, signal.SIGWINCH)
                                    continue
                                except (json.JSONDecodeError, KeyError):
                                    pass
                            os.write(master_fd, line + b"\n")

                        if stdin_buf and b"\n" not in stdin_buf:
                            if stdin_buf.startswith(b'{"type":"resize"'):
                                continue
                            os.write(master_fd, stdin_buf)
                            stdin_buf = b""

                    except OSError:
                        return

            try:
                result = os.waitpid(pid, os.WNOHANG)
                if result[0] != 0:
                    return
            except ChildProcessError:
                return

    except KeyboardInterrupt:
        pass
    finally:
        os.close(master_fd)
        try:
            os.kill(pid, signal.SIGTERM)
            os.waitpid(pid, 0)
        except (OSError, ChildProcessError):
            pass

if __name__ == "__main__":
    main()
