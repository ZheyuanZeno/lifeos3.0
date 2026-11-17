"""One reentrant writer lock shared by the desktop HTTP app and archive process."""
import contextlib
import os
import threading
from pathlib import Path

_guard = threading.Lock()
_states = {}


@contextlib.contextmanager
def data_lock(directory):
    path = str(Path(directory).resolve() / '.lifeos-writer.lock')
    with _guard:
        state = _states.setdefault(path, {'lock': threading.RLock(), 'depth': 0})
    with state['lock']:
        if state['depth'] == 0:
            Path(directory).mkdir(parents=True, exist_ok=True)
            stream = open(path, 'a+b')
            if os.name == 'nt':
                import msvcrt
                stream.seek(0, 2)
                if stream.tell() == 0:
                    stream.write(b'\0')
                    stream.flush()
                stream.seek(0)
                # msvcrt's blocking lock has a short fixed retry window; retry contention.
                import time
                while True:
                    try:
                        msvcrt.locking(stream.fileno(), msvcrt.LK_NBLCK, 1)
                        break
                    except OSError:
                        time.sleep(.1)
            else:
                import fcntl
                fcntl.flock(stream.fileno(), fcntl.LOCK_EX)
            state['stream'] = stream
        state['depth'] += 1
        try:
            yield
        finally:
            state['depth'] -= 1
            if state['depth'] == 0:
                stream = state.pop('stream')
                if os.name == 'nt':
                    import msvcrt
                    stream.seek(0)
                    msvcrt.locking(stream.fileno(), msvcrt.LK_UNLCK, 1)
                else:
                    import fcntl
                    fcntl.flock(stream.fileno(), fcntl.LOCK_UN)
                stream.close()
