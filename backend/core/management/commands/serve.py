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

        if host not in ('127.0.0.1', 'localhost', '::1') and not settings.MARUMADO_TOKEN:
            self.stderr.write(self.style.WARNING(
                'Listening beyond localhost without MARUMADO_TOKEN: anyone on the network can kill processes and type into your agents.'))
        call_command('migrate', interactive=False, verbosity=0)
        call_command('scan')
        self.stdout.write(self.style.SUCCESS(f'Marumado on http://{host}:{port}'))
        uvicorn.run('marumado.asgi:application', host=host, port=port, ws='websockets-sansio', lifespan='off', access_log=False, log_level='warning')
