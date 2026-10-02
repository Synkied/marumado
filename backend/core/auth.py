"""Access to Marumado: one shared token, always required, localhost included.

Browsers trade the token once (POST /api/auth) for an HttpOnly session cookie. Other Marumados and scripts send
`Authorization: Bearer <token>`. Without MARUMADO_TOKEN, a random token is made on first run and kept in data/.
An optional password (`manage.py password`, hashed in data/password) also logs browsers in; the token keeps
working, so a forgotten password is never a lockout. Sessions hold a digest of the token and the password hash,
so changing either logs every browser out.
"""
import hashlib
import hmac
import secrets
import threading
import time

from django.conf import settings

TOKEN_FILE = settings.BASE_DIR / 'data' / 'access-token'
PASSWORD_FILE = settings.BASE_DIR / 'data' / 'password'
SESSION_KEY = 'marumado_auth'
# Changes made with the session cookie must carry this header. Other sites (including other dev servers on
# localhost, which count as the same site for cookies) can't add it without a CORS preflight Marumado never allows.
CSRF_HEADER = 'X-Marumado'
SAFE_METHODS = ('GET', 'HEAD', 'OPTIONS')

# Wrong guesses: this many different wrong tokens from one address within the window lock that address out.
# The same wrong token sent again (a misconfigured machine polling) counts once.
MAX_GUESSES = 10
WINDOW_SECONDS = 15 * 60

_lock = threading.Lock()
_guesses: dict[str, dict[str, float]] = {}
_token: str | None = None
_password: tuple[int, str] = (0, '')  # (mtime_ns, hash) of PASSWORD_FILE, reread when `manage.py password` changes it


def token() -> str:
    """MARUMADO_TOKEN, or the one made on first run and saved in data/access-token."""
    global _token
    if settings.MARUMADO_TOKEN:
        return settings.MARUMADO_TOKEN
    if _token is None:
        with _lock:
            if _token is None:
                _token = _stored_token()
    return _token


def generated() -> bool:
    return not settings.MARUMADO_TOKEN


def _stored_token() -> str:
    try:
        saved = TOKEN_FILE.read_text().strip()
        if saved:
            return saved
    except FileNotFoundError:
        pass
    new = secrets.token_hex(16)
    TOKEN_FILE.parent.mkdir(parents=True, exist_ok=True)
    TOKEN_FILE.touch(mode=0o600)
    TOKEN_FILE.write_text(new + '\n')
    return new


def password_hash() -> str:
    """The saved password's hash, or '' when no password is set."""
    global _password
    try:
        mtime = PASSWORD_FILE.stat().st_mtime_ns
    except FileNotFoundError:
        return ''
    if _password[0] != mtime:
        _password = (mtime, PASSWORD_FILE.read_text().strip())
    return _password[1]


def set_password(raw: str | None):
    """Save a new password (hashed), or remove it with None."""
    from django.contrib.auth.hashers import make_password
    if raw is None:
        PASSWORD_FILE.unlink(missing_ok=True)
        return
    PASSWORD_FILE.parent.mkdir(parents=True, exist_ok=True)
    PASSWORD_FILE.touch(mode=0o600)
    PASSWORD_FILE.write_text(make_password(raw) + '\n')


def _password_matches(given: str) -> bool:
    from django.contrib.auth.hashers import check_password
    saved = password_hash()
    return bool(given and saved) and check_password(given, saved)


def _digest(value: str) -> str:
    return hashlib.sha256(value.encode()).hexdigest()


def matches(given: str) -> bool:
    return bool(given) and hmac.compare_digest(_digest(given), _digest(token()))


def _credential() -> str:
    return _digest(f'{token()}\0{password_hash()}')


def session_ok(session) -> bool:
    return hmac.compare_digest(str(session.get(SESSION_KEY, '')), _credential())


def log_in(session):
    session.cycle_key()
    session[SESSION_KEY] = _credential()


# ---------------------------------------------------------------- wrong guesses

class Locked(Exception):
    def __init__(self, wait: float):
        self.wait = wait
        minutes = max(1, round(wait / 60))
        super().__init__(f'Too many wrong tokens from this address. Try again in {minutes} minute{"s" if minutes > 1 else ""}.')


def _recent(address: str, now: float) -> dict[str, float]:
    seen = {d: t for d, t in _guesses.get(address, {}).items() if now - t < WINDOW_SECONDS}
    if seen:
        _guesses[address] = seen
    else:
        _guesses.pop(address, None)
    return seen


def check_locked(address: str):
    """Raise Locked while `address` has made too many wrong guesses."""
    now = time.monotonic()
    with _lock:
        seen = _recent(address, now)
        if len(seen) >= MAX_GUESSES:
            raise Locked(min(seen.values()) + WINDOW_SECONDS - now)


def wrong_guess(address: str, given: str):
    with _lock:
        _guesses.setdefault(address, {})[_digest(given)] = time.monotonic()


def try_token(address: str, given: str) -> bool:
    """Whether `given` is the token, counting it against `address` when it isn't. Raises Locked."""
    check_locked(address)
    if matches(given):
        return True
    wrong_guess(address, given)
    return False


def try_login(address: str, given: str) -> bool:
    """Like try_token, but the browser's password works too."""
    check_locked(address)
    if matches(given) or _password_matches(given):
        return True
    wrong_guess(address, given)
    return False


def bearer(header: str) -> str | None:
    """The token in an Authorization header, or None when there is no bearer token."""
    if not header.startswith('Bearer '):
        return None
    return header.removeprefix('Bearer ').strip()
