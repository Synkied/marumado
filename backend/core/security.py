"""Security audit of the machine Marumado runs on: what is open to the network, which processes look wrong, how the
containers are set up, how SSH and updates are configured, and secrets left in the projects' repositories.

Each check reads what the monitor already sampled, or the host's own files, and turns what it sees into findings:
what is wrong, why it matters, and what to do about it (a command to run where there is one). Nothing is changed:
the owner runs the fix. In Docker the host's files are read through /proc/1/root (the container shares the host's
process namespace and may trace its processes); a check that can't read what it needs says so instead of guessing.
"""

import ipaddress
import os
import re
import stat
import subprocess
import threading
import time
from pathlib import Path

import psutil
from django.conf import settings

from . import monitor

HIGH, MEDIUM, LOW, INFO = 'high', 'medium', 'low', 'info'
RANK = {HIGH: 0, MEDIUM: 1, LOW: 2, INFO: 3}

# Services that should never answer the whole network: anyone who reaches them owns the data, or the machine.
RISKY_PORTS = {
    21: 'FTP', 23: 'Telnet', 111: 'rpcbind', 139: 'SMB', 445: 'SMB', 2049: 'NFS',
    2375: 'the Docker API (unencrypted)', 2376: 'the Docker API', 3306: 'MySQL', 3389: 'Remote Desktop',
    5432: 'PostgreSQL', 5900: 'VNC', 5984: 'CouchDB', 6379: 'Redis', 8086: 'InfluxDB', 9200: 'Elasticsearch',
    11211: 'memcached', 27017: 'MongoDB',
}
# Root on the machine for whoever reaches them, with no password at all.
CRITICAL_PORTS = {2375, 6379, 11211}
# Answering the network is these services' job: they get their own checks (SSH) or are expected (DNS, DHCP, mDNS).
EXPECTED_PORTS = {22, 53, 67, 68, 546, 547, 5353}

MINER_NAMES = {'xmrig', 'xmr-stak', 'minerd', 'cpuminer', 'kdevtmpfsi', 'kinsing', 'ethminer', 'nbminer', 't-rex'}
MINING_POOL_PORTS = {3333, 5555, 7777, 14433, 14444, 45560, 45700}
TEMP_DIRS = ('/tmp/', '/var/tmp/', '/dev/shm/')
FIREWALLS = {'firewalld', 'ufw', 'nftables', 'iptables', 'csf', 'lfd'}
BRUTE_FORCE_GUARDS = {'fail2ban-server', 'fail2ban', 'crowdsec', 'sshguard'}
SECRET_FILES = re.compile(
    r'(^|/)(\.env(\.(?!example$|sample$|template$|dist$)[\w.-]+)?|id_(rsa|ecdsa|ed25519|dsa)|[^/]+\.(pem|key|p12|pfx)'
    r'|credentials\.json|service-account[^/]*\.json|\.npmrc|\.pypirc|\.netrc)$'
)

ACCEPTED = 'security_accepted'
CACHE_SECONDS = 30

_lock = threading.Lock()
_cache: tuple[float, dict] | None = None


def _finding(fid: str, area: str, severity: str, title: str, detail: str, action: str, command: str = '') -> dict:
    return {'id': fid, 'area': area, 'severity': severity, 'title': title, 'detail': detail, 'action': action,
            'command': command}


# ---------------------------------------------------------------- the host's files

def _in_container() -> bool:
    return Path('/.dockerenv').exists()


def host_path(path: str) -> Path:
    """`path` on the host: through PID 1's root from inside the container, as is outside it."""
    if _in_container():
        root = Path('/proc/1/root')
        if os.access(root, os.R_OK | os.X_OK):
            return root / path.lstrip('/')
    return Path(path)


def _read(path: str) -> str | None:
    try:
        return host_path(path).read_text(errors='replace')
    except (OSError, ValueError):
        return None


def _host_home() -> Path:
    return Path(os.environ.get('MARUMADO_HOST_HOME') or Path.home())


# ---------------------------------------------------------------- network

def _wildcard(address: str) -> bool:
    return address in ('', '0.0.0.0', '::', '*')


def _public(address: str) -> bool:
    try:
        ip = ipaddress.ip_address(address)
    except ValueError:
        return False
    return ip.is_global


def _published(containers: list[dict]) -> dict[int, dict]:
    """Host port → the container that publishes it, for ports Docker opens on every address."""
    out = {}
    for c in containers:
        for p in c.get('ports') or []:
            if _wildcard(p.get('host_ip', '')):
                out[p['host_port']] = c
    return out


def check_network(ports: list[dict], processes: list[dict], containers: list[dict]) -> list[dict]:
    users = {p['pid']: p.get('user', '') for p in processes}
    published = _published(containers)
    out, seen = [], set()
    for r in ports:
        port = r['port']
        if not _wildcard(r['address']) or port in EXPECTED_PORTS or (port, r['proto']) in seen:
            continue
        seen.add((port, r['proto']))
        owner = r['process'] or 'an unknown process'
        container = published.get(port)
        where = f"the container {container['name']}" if container else owner
        if container:
            action = (f'Publish it on 127.0.0.1 only: in its compose file, write "127.0.0.1:{port}:…" instead of '
                      f'"{port}:…", then recreate it. Docker writes its own firewall rules, so ufw alone does not '
                      'close a published port.')
            command = ''
        else:
            action = f'Make {owner} listen on 127.0.0.1 if only this machine uses it, or allow it through the firewall only from the addresses that need it.'
            command = f'sudo ufw deny {port}/{r["proto"]}'
        if port in RISKY_PORTS:
            service = RISKY_PORTS[port]
            out.append(_finding(
                f'net:exposed:{port}', 'network', HIGH if port in CRITICAL_PORTS or not container else MEDIUM,
                f'{service} is open to the network on :{port}',
                f'{where} answers on every address. {service} is meant for this machine or a private network; '
                'bots scan the internet for it all day.', action, command))
        else:
            root = users.get(r['pid']) == 'root'
            out.append(_finding(
                f'net:open:{port}', 'network', MEDIUM if root else LOW,
                f':{port} is open to the network ({where})',
                f"{where} listens on every address{', as root' if root else ''}. Anyone on the same network can reach it"
                f"{', and a flaw in it gives them the machine' if root else ''}.", action, command))
    return out


def check_connections() -> list[dict]:
    """Processes talking to a public address on a port mining pools use: the mark of a cryptominer."""
    try:
        conns = psutil.net_connections(kind='inet')
    except (psutil.AccessDenied, OSError):
        return []
    out, seen = [], set()
    for c in conns:
        if c.status != psutil.CONN_ESTABLISHED or not c.raddr or c.raddr.port not in MINING_POOL_PORTS:
            continue
        if not _public(c.raddr.ip) or c.pid in seen:
            continue
        seen.add(c.pid)
        try:
            name = psutil.Process(c.pid).name() if c.pid else 'an unknown process'
        except psutil.Error:
            name = f'pid {c.pid}'
        out.append(_finding(
            f'net:pool:{name}', 'network', MEDIUM, f'{name} talks to {c.raddr.ip}:{c.raddr.port}',
            f'Port {c.raddr.port} is one cryptocurrency mining pools use. It may be harmless, but a miner hidden on a '
            'server looks exactly like this.',
            'Check what this program is and where it came from; stop it if you don’t know it.',
            f'ls -l /proc/{c.pid}/exe; cat /proc/{c.pid}/cmdline | tr "\\0" " "' if c.pid else ''))
    return out


def check_firewall(processes: list[dict], network: list[dict]) -> list[dict]:
    names = {p['name'] for p in processes}
    if names & {'firewalld', 'csf', 'lfd'}:
        return []
    ufw = _read('/etc/ufw/ufw.conf')
    if ufw is not None and re.search(r'^\s*ENABLED\s*=\s*yes', ufw, re.MULTILINE):
        return []
    nft = _read('/etc/nftables.conf')
    if nft is not None and re.search(r'\bpolicy\s+drop\b', nft):
        return []
    if ufw is None and nft is None and _read('/etc/os-release') is None:
        return []  # can't see the host's files: the unknowns list says so
    if not network:
        return [_finding(
            'fw:none', 'network', LOW, 'No firewall is turned on',
            'Nothing is open to the network right now, so nothing is at risk today; a firewall keeps it that way '
            'when a new service starts listening on every address.',
            'Turn on ufw, allowing SSH first so you don’t lock yourself out.',
            'sudo ufw allow OpenSSH && sudo ufw enable')]
    return [_finding(
        'fw:none', 'network', MEDIUM, 'No firewall is turned on',
        f'{len(network)} port{"s are" if len(network) > 1 else " is"} open to the network, with nothing in front of '
        'them.', 'Turn on ufw, allowing SSH first so you don’t lock yourself out, then only what must be reachable.',
        'sudo ufw default deny incoming && sudo ufw allow OpenSSH && sudo ufw enable')]


def check_marumado() -> list[dict]:
    out = []
    bind = os.environ.get('MARUMADO_BIND', '127.0.0.1')
    open_to_lan = bind not in ('127.0.0.1', 'localhost', '::1')
    if open_to_lan and settings.DEBUG:
        out.append(_finding(
            'mm:debug', 'marumado', HIGH, 'Marumado runs in debug mode, open to the network',
            'Debug pages show settings and code to whoever triggers an error.',
            'Set MARUMADO_DEBUG=0 in .env, then make restart.'))
    if settings.SECRET_KEY in ('change-me-in-dot-env', 'django-insecure-local-only-marumado'):
        out.append(_finding(
            'mm:secret-key', 'marumado', MEDIUM if open_to_lan else LOW, 'Marumado uses the default secret key',
            'It signs login cookies; with the default one, anyone who has read this code can forge them.',
            'Put a random key in .env, then make restart (it logs every browser out).',
            'echo "MARUMADO_SECRET_KEY=$(openssl rand -hex 32)" >> .env'))
    if settings.MARUMADO_TOKEN and len(settings.MARUMADO_TOKEN) < 20:
        out.append(_finding(
            'mm:token', 'marumado', MEDIUM, 'Marumado’s access token is short',
            f'MARUMADO_TOKEN has {len(settings.MARUMADO_TOKEN)} characters. It can stop processes and type into your '
            'agents, so it should be long and random.',
            'Set MARUMADO_TOKEN=$(make token) in .env, then make restart.'))
    if open_to_lan:
        terminal = os.environ.get('MARUMADO_HERDR_TERMINAL', 'control').strip().lower()
        out.append(_finding(
            'mm:lan', 'marumado', MEDIUM if terminal == 'control' else LOW,
            f'Marumado answers the network on {bind}, over plain HTTP',
            'The login and everything you see travel unencrypted on the network'
            + (', and whoever logs in can type into your agents.' if terminal == 'control' else '.'),
            'Keep MARUMADO_BIND=127.0.0.1 and reach it through an SSH tunnel, a VPN (Tailscale, WireGuard) or an '
            'HTTPS reverse proxy.'))
    return out


# ---------------------------------------------------------------- processes

def _exe_link(pid: int) -> str:
    try:
        return os.readlink(f'/proc/{pid}/exe')
    except OSError:
        return ''


def check_processes(processes: list[dict]) -> list[dict]:
    out, stale = [], []
    for p in processes:
        if p.get('kernel'):
            continue
        name, pid = p['name'], p['pid']
        exe = _exe_link(pid)
        deleted = exe.endswith(' (deleted)')
        path = exe.removesuffix(' (deleted)')
        if name.lower() in MINER_NAMES or Path(path).name.lower() in MINER_NAMES:
            out.append(_finding(
                f'proc:miner:{name}', 'processes', HIGH, f'{name} looks like a cryptominer',
                f'pid {pid}, run by {p.get("user") or "?"}, using {p["cpu"]}% CPU. Its name is that of a known miner, '
                'often dropped by attackers through an exposed service.',
                'Stop it, then find how it got here: what is open to the network, and the crontabs and systemd units '
                'that may start it again.', f'sudo kill -9 {pid}; sudo crontab -l; crontab -l -u {p.get("user") or "root"}'))
        elif path.startswith(TEMP_DIRS):
            out.append(_finding(
                f'proc:temp:{path}', 'processes', HIGH, f'{name} runs from {path.rsplit("/", 1)[0]}',
                f'pid {pid}, run by {p.get("user") or "?"}. Programs rarely run from a temporary folder; malware '
                'dropped through a vulnerable service usually does.',
                'Check what it is and who started it; stop it if you don’t know it.',
                f'ls -l /proc/{pid}/exe; ps -o pid,ppid,user,lstart,cmd -p {pid}'))
        elif deleted and path:
            stale.append(f'{name} ({pid})')
    if stale:
        out.append(_finding(
            'proc:stale', 'processes', LOW,
            f'{len(stale)} program{"s run" if len(stale) > 1 else " runs"} from a file that has been replaced',
            f'{", ".join(stale[:8])}{" and more" if len(stale) > 8 else ""}. Usually an update installed a new version '
            'and the old one is still in memory, without its security fixes.',
            'Restart these services (or the machine). needrestart lists them.', 'sudo needrestart -r l'))
    return out


# ---------------------------------------------------------------- containers

def _own_container(c) -> bool:
    labels = c.labels or {}
    return c.name == 'marumado' or labels.get('com.docker.compose.project') == 'marumado'


def check_containers() -> list[dict]:
    try:
        containers = monitor.docker_client().containers.list()
    except Exception:
        return []
    out = []
    for c in containers:
        if _own_container(c):
            continue  # it needs the host's processes, network and Docker socket: that is how it watches the machine
        host = c.attrs.get('HostConfig') or {}
        mounts = c.attrs.get('Mounts') or []
        caps = set(host.get('CapAdd') or [])
        if host.get('Privileged'):
            out.append(_finding(
                f'ctr:privileged:{c.name}', 'containers', HIGH, f'{c.name} runs privileged',
                'A privileged container can do anything the host’s root can: a flaw in it is a flaw in the machine.',
                'Remove privileged: true and add only the capabilities or devices it actually needs.'))
        elif caps & {'ALL', 'SYS_ADMIN', 'NET_ADMIN', 'SYS_MODULE'}:
            out.append(_finding(
                f'ctr:caps:{c.name}', 'containers', MEDIUM, f'{c.name} has powerful capabilities',
                f'cap_add: {", ".join(sorted(caps))}. These let it change the host’s network or kernel.',
                'Keep only the capabilities it needs.'))
        if any((m.get('Source') or '').endswith('docker.sock') for m in mounts):
            out.append(_finding(
                f'ctr:socket:{c.name}', 'containers', MEDIUM, f'{c.name} can drive Docker',
                'It has the Docker socket mounted, which is root on the host for anything running inside it.',
                'Remove the mount if it doesn’t need it, or put a socket proxy that allows only what it uses '
                '(tecnativa/docker-socket-proxy) in between.'))
        if host.get('PidMode') == 'host' or host.get('NetworkMode') == 'host':
            shared = [k for k, v in (('processes', host.get('PidMode')), ('network', host.get('NetworkMode'))) if v == 'host']
            out.append(_finding(
                f'ctr:host-ns:{c.name}', 'containers', LOW, f'{c.name} shares the host’s {" and ".join(shared)}',
                'It is less isolated from the machine than a container usually is.',
                'Give it its own network (publish only the ports it serves) unless it needs the host’s.'))
    return out


# ---------------------------------------------------------------- system

def _sshd_options() -> dict[str, str] | None:
    """sshd's settings as it reads them: the first value of each option wins, drop-ins (included at the top on
    Debian and Ubuntu) before the main file."""
    main = _read('/etc/ssh/sshd_config')
    if main is None:
        return None
    texts = []
    try:
        texts += [f.read_text(errors='replace') for f in sorted(host_path('/etc/ssh/sshd_config.d').glob('*.conf'))]
    except OSError:
        pass
    texts.append(main)
    opts: dict[str, str] = {}
    for text in texts:
        for line in text.splitlines():
            line = line.split('#', 1)[0].strip()
            if line.lower().startswith('match '):
                break  # what follows applies to some users or addresses only
            key, _, value = line.partition(' ')
            if key:
                opts.setdefault(key.lower(), value.strip().lower())
    return opts


def check_ssh(processes: list[dict], ports: list[dict]) -> list[dict]:
    if not any(p['name'] == 'sshd' for p in processes) and not any(r['port'] == 22 for r in ports):
        return []
    opts = _sshd_options()
    if opts is None:
        return []
    out = []
    restart = 'sudo systemctl reload ssh || sudo systemctl reload sshd'
    exposed = any(r['port'] == 22 and _wildcard(r['address']) for r in ports)
    if opts.get('permitrootlogin') == 'yes':
        out.append(_finding(
            'ssh:root', 'system', HIGH, 'SSH lets root log in',
            'PermitRootLogin yes: root is the one account every attacker tries first.',
            'Log in as yourself and use sudo. Set PermitRootLogin no in /etc/ssh/sshd_config, then reload sshd.',
            f"sudo sed -i 's/^#\\?PermitRootLogin.*/PermitRootLogin no/' /etc/ssh/sshd_config && {restart}"))
    if opts.get('passwordauthentication', 'yes') == 'yes':
        out.append(_finding(
            'ssh:password', 'system', MEDIUM if exposed else LOW, 'SSH accepts passwords',
            'Passwords can be guessed by bots trying thousands a day; keys can’t.'
            + ('' if exposed else ' SSH is only reachable locally right now.'),
            'Check that your key logs you in, then set PasswordAuthentication no and reload sshd.',
            f"sudo sed -i 's/^#\\?PasswordAuthentication.*/PasswordAuthentication no/' /etc/ssh/sshd_config && {restart}"))
        if exposed and not {p['name'] for p in processes} & BRUTE_FORCE_GUARDS:
            out.append(_finding(
                'ssh:guard', 'system', LOW, 'Nothing slows down password guessing on SSH',
                'No fail2ban, CrowdSec or sshguard is running, so a bot can keep trying.',
                'Turn off password logins (above), or install fail2ban.', 'sudo apt install fail2ban'))
    if opts.get('permitemptypasswords') == 'yes':
        out.append(_finding(
            'ssh:empty', 'system', HIGH, 'SSH accepts empty passwords',
            'PermitEmptyPasswords yes: an account with no password can be entered by anyone.',
            'Set PermitEmptyPasswords no and reload sshd.'))
    return out


def check_updates() -> list[dict]:
    out = []
    if host_path('/var/run/reboot-required').exists():
        pkgs = (_read('/var/run/reboot-required.pkgs') or '').split()
        out.append(_finding(
            'upd:reboot', 'system', MEDIUM, 'A reboot is waiting',
            'Updates were installed that only take effect after a restart'
            + (f' ({", ".join(sorted(set(pkgs))[:6])}).' if pkgs else '.'),
            'Reboot when it suits you.', 'sudo reboot'))
    notice = _read('/var/lib/update-notifier/updates-available') or ''
    # Ubuntu's login notice: "2 of these updates are standard security updates." (older: "2 updates are security updates.")
    m = re.search(r'(\d+)(?: of these)? updates? (?:is|are) (?:a )?(?:standard )?security update', notice)
    security = int(m.group(1)) if m else 0
    if security:
        out.append(_finding(
            'upd:security', 'system', MEDIUM, f'{security} security update{"s are" if security > 1 else " is"} waiting',
            'Known flaws are fixed in them; until they are installed, the machine still has those flaws.',
            'Install them.', 'sudo apt update && sudo apt upgrade'))
    if host_path('/etc/debian_version').exists():
        auto = _read('/etc/apt/apt.conf.d/20auto-upgrades') or ''
        if not re.search(r'Unattended-Upgrade\s+"1"', auto):
            out.append(_finding(
                'upd:auto', 'system', LOW, 'Security updates aren’t installed by themselves',
                'unattended-upgrades is off, so fixes wait until someone runs apt by hand.',
                'Turn it on: it installs security updates every day.',
                'sudo apt install unattended-upgrades && sudo dpkg-reconfigure -plow unattended-upgrades'))
    return out


def check_accounts() -> list[dict]:
    out = []
    passwd = _read('/etc/passwd')
    if passwd:
        roots = [line.split(':')[0] for line in passwd.splitlines() if line.count(':') >= 3 and line.split(':')[2] == '0']
        others = [u for u in roots if u != 'root']
        if others:
            out.append(_finding(
                'acct:uid0', 'system', HIGH, f'{", ".join(others)} {"is" if len(others) == 1 else "are"} root under another name',
                'Accounts with user id 0 have every right root has. Attackers add one to keep a way back in.',
                'Remove the account unless you made it on purpose.', f'sudo userdel {others[0]}'))
    shadow = _read('/etc/shadow')
    if shadow:
        empty = [line.split(':')[0] for line in shadow.splitlines() if line.count(':') >= 2 and line.split(':')[1] == '']
        if empty:
            out.append(_finding(
                'acct:empty', 'system', HIGH, f'{", ".join(empty[:5])} {"has" if len(empty) == 1 else "have"} no password',
                'An account with an empty password can be entered without one, from a console or a service that allows it.',
                'Lock it, or give it a password.', f'sudo passwd -l {empty[0]}'))
    group = _read('/etc/group')
    if group:
        for line in group.splitlines():
            parts = line.split(':')
            if len(parts) == 4 and parts[0] == 'docker' and parts[3]:
                members = parts[3].split(',')
                out.append(_finding(
                    'acct:docker', 'system', INFO, f'{", ".join(members)} can use Docker, which is root',
                    'Anyone in the docker group can start a container that mounts the whole disk. That is often what '
                    'you want on your own machine; on a shared server, it is sudo without a password.',
                    'Keep the group to the people who would have sudo anyway, or use rootless Docker.'))
    return out


# ---------------------------------------------------------------- keys and secrets

def _unprotected_key(text: str) -> bool:
    if 'ENCRYPTED' in text:
        return False
    if 'BEGIN OPENSSH PRIVATE KEY' in text:
        import base64
        body = ''.join(line for line in text.splitlines() if line and not line.startswith('-----'))
        try:
            return b'none' in base64.b64decode(body)[:64]  # the cipher name, right after the magic
        except ValueError:
            return False
    return 'PRIVATE KEY' in text


def check_ssh_keys() -> list[dict]:
    folder = _host_home() / '.ssh'
    try:
        files = [f for f in folder.iterdir() if f.is_file()]
    except OSError:
        return []
    out, bare = [], []
    for f in files:
        try:
            head = f.read_text(errors='replace')[:4000]
            mode = f.stat().st_mode
        except OSError:
            continue
        if 'PRIVATE KEY' not in head:
            continue
        if mode & (stat.S_IRWXG | stat.S_IRWXO):
            out.append(_finding(
                f'key:mode:{f.name}', 'secrets', HIGH, f'~/.ssh/{f.name} can be read by other users',
                f'Its permissions are {stat.filemode(mode)}. Anyone with an account here can copy it and log in where it does.',
                'Make it yours only.', f'chmod 600 ~/.ssh/{f.name}'))
        if _unprotected_key(head):
            bare.append(f.name)
    if bare:
        out.append(_finding(
            'key:bare', 'secrets', LOW,
            f'{len(bare)} SSH key{"s have" if len(bare) > 1 else " has"} no passphrase',
            f'{", ".join(bare)}. Whoever gets a copy of the file (a backup, a stolen laptop) can use it at once.',
            'Add a passphrase; ssh-agent keeps you from typing it every time. Keys that machines use on their own '
            '(Marumado’s tunnels, deploys) are fine without one if they are limited where they log in.',
            f'ssh-keygen -p -f ~/.ssh/{bare[0]}'))
    return out


def _tracked(path: str) -> list[str]:
    try:
        res = subprocess.run(['git', '-C', path, 'ls-files', '-z'], capture_output=True, timeout=5, check=False)
    except (OSError, subprocess.TimeoutExpired):
        return []
    return res.stdout.decode(errors='replace').split('\0') if res.returncode == 0 else []


def check_repos() -> list[dict]:
    from .models import Project
    out = []
    for p in Project.objects.filter(kind=Project.KIND_PROJECT, hidden=False).exclude(path=''):
        if not Path(p.path, '.git').exists():
            continue
        hits = [f for f in _tracked(p.path) if f and SECRET_FILES.search(f)]
        if hits:
            out.append(_finding(
                f'repo:secrets:{p.id}', 'secrets', HIGH if p.detected.get('repo_url') else MEDIUM,
                f'{p.name} keeps secrets in git',
                f'{", ".join(hits[:5])}{" and more" if len(hits) > 5 else ""} {"is" if len(hits) == 1 else "are"} '
                'committed. Everyone who can read the repository, and every clone of it, has them.',
                'Stop tracking them, add them to .gitignore, and change the secrets they hold: they stay in the '
                'history even once removed.',
                f'cd {p.path} && git rm --cached {" ".join(hits[:5])} && printf "%s\\n" {" ".join(hits[:5])} >> .gitignore'))
    return out


# ---------------------------------------------------------------- the audit

def _unknowns() -> list[str]:
    out = []
    if _read('/etc/os-release') is None:
        out.append('The host’s files can’t be read from here, so SSH, updates, accounts and the firewall weren’t checked.'
                   + (' Give the container SYS_PTRACE (compose.yaml has it) and run it as root.' if _in_container() else ''))
    if not monitor.snapshot('docker').get('available'):
        out.append('Docker isn’t reachable, so containers weren’t checked.')
    if any(r['pid'] is None for r in monitor.snapshot('ports')):
        out.append('Some ports have no process attached: this host hides which program owns a socket.')
    return out


def accepted() -> dict:
    from .models import Setting
    row = Setting.objects.filter(key=ACCEPTED).first()
    return row.value if row and isinstance(row.value, dict) else {}


def accept(fid: str, note: str = '') -> None:
    from .models import Setting
    row, _ = Setting.objects.get_or_create(key=ACCEPTED, defaults={'value': {}})
    row.value = {**(row.value or {}), fid: {'note': note[:300], 'at': time.time()}}
    row.save()


def unaccept(fid: str) -> None:
    from .models import Setting
    row = Setting.objects.filter(key=ACCEPTED).first()
    if row and fid in (row.value or {}):
        row.value = {k: v for k, v in row.value.items() if k != fid}
        row.save()


def _run() -> dict:
    processes = monitor.snapshot('processes')
    ports = monitor.snapshot('ports')
    containers = monitor.snapshot('docker').get('containers') or []
    network = check_network(ports, processes, containers)
    findings = [
        *network, *check_connections(), *check_firewall(processes, network), *check_marumado(),
        *check_processes(processes), *check_containers(),
        *check_ssh(processes, ports), *check_updates(), *check_accounts(),
        *check_ssh_keys(), *check_repos(),
    ]
    findings.sort(key=lambda f: (RANK[f['severity']], f['area'], f['title']))
    return {'checked_at': time.time(), 'findings': findings, 'unknown': _unknowns()}


def audit(fresh: bool = False) -> dict:
    """The latest audit (at most CACHE_SECONDS old, or run now), with the findings the owner accepted marked."""
    global _cache
    with _lock:
        if fresh or _cache is None or time.time() - _cache[0] > CACHE_SECONDS:
            _cache = (time.time(), _run())
        data = _cache[1]
    ok = accepted()
    return {**data, 'findings': [{**f, 'accepted': ok.get(f['id'])} for f in data['findings']]}
