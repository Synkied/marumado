import logging
import sys
import threading

from django.apps import AppConfig

log = logging.getLogger('core')


def _thread_failed(args: threading.ExceptHookArgs) -> None:
    """An exception that ends one of Marumado's background threads (monitor, tunnels, tasks): into the log, with its
    traceback, instead of only on stderr."""
    if args.exc_type is SystemExit:
        return
    name = args.thread.name if args.thread else '?'
    log.error('background thread %s failed', name, exc_info=(args.exc_type, args.exc_value, args.exc_traceback))


def _uncaught(exc_type, exc_value, exc_traceback) -> None:
    if issubclass(exc_type, KeyboardInterrupt):
        return sys.__excepthook__(exc_type, exc_value, exc_traceback)
    log.critical('uncaught exception', exc_info=(exc_type, exc_value, exc_traceback))


class CoreConfig(AppConfig):
    name = 'core'

    def ready(self):
        threading.excepthook = _thread_failed
        sys.excepthook = _uncaught
