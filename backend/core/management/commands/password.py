from getpass import getpass

from django.contrib.auth.password_validation import validate_password
from django.core.exceptions import ValidationError
from django.core.management.base import BaseCommand, CommandError

from core import auth


class Command(BaseCommand):
    help = 'Set the password browsers can log in with (the access token keeps working). Logs every browser out.'

    def add_arguments(self, parser):
        parser.add_argument('--clear', action='store_true', help='Remove the password: only the access token logs in')

    def handle(self, *args, **opts):
        if opts['clear']:
            auth.set_password(None)
            self.stdout.write('Password removed. Log in with the access token (`make access-token` prints it).')
            return
        raw = getpass('New password: ')
        if raw != getpass('Again: '):
            raise CommandError("The two passwords don't match.")
        try:
            validate_password(raw)
        except ValidationError as exc:
            raise CommandError(' '.join(exc.messages))
        auth.set_password(raw)
        self.stdout.write('Password set. Every browser must log in again, with it or with the access token.')
