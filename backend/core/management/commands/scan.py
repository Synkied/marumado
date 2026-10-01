from django.core.management.base import BaseCommand

from core import discovery


class Command(BaseCommand):
    help = 'Scan MARUMADO_PROJECT_ROOTS for projects'

    def handle(self, *args, **opts):
        self.stdout.write(str(discovery.scan()))
