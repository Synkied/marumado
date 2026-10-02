from django.core.management.base import BaseCommand

from core import auth


class Command(BaseCommand):
    help = "Print this Marumado's access token (MARUMADO_TOKEN, or the one made on first run)"

    def handle(self, *args, **opts):
        self.stdout.write(auth.token())
