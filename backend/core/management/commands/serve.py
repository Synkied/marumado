from django.core.management import call_command
from django.core.management.base import BaseCommand

from marumado.settings import env


class Command(BaseCommand):
    help = 'Migrate, scan projects, and serve Marumado (API, live terminal and built frontend) with uvicorn'

    def add_arguments(self, parser):
        parser.add_argument('--host', default=env('BIND', '127.0.0.1'))
        parser.add_argument('--port', type=int, default=int(env('PORT', '7878')))

    def handle(self, *args, host, port, **opts):
        import uvicorn
        from django.conf import settings

        from core import auth

        if auth.generated():
            new = not auth.TOKEN_FILE.exists()
            token = auth.token()
            self.stdout.write(
                f'Access token: {token}  (made on first run; set MARUMADO_TOKEN to choose your own)' if new else
                'Access token: the one in data/access-token (`make access-token` or `manage.py token` prints it)')
        elif len(settings.MARUMADO_TOKEN) < 16:
            self.stderr.write(self.style.WARNING('MARUMADO_TOKEN is short and easy to guess. `make token` prints a strong one.'))
        if host not in ('127.0.0.1', 'localhost', '::1'):
            self.stderr.write(self.style.WARNING(
                'Listening beyond localhost over plain HTTP: anyone on the network path can read the token as it is sent.'
                ' Prefer an SSH tunnel, a VPN (Tailscale, WireGuard) or an HTTPS reverse proxy.'))
        call_command('migrate', interactive=False, verbosity=0)
        call_command('scan')
        self.stdout.write(self.style.SUCCESS(f'Marumado on http://{host}:{port}'))
        uvicorn.run('marumado.asgi:application', host=host, port=port, ws='websockets-sansio', lifespan='off', access_log=False, log_level='warning')
