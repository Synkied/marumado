import hmac

from django.conf import settings
from rest_framework.permissions import BasePermission


class MarumadoToken(BasePermission):
    """Open when MARUMADO_TOKEN is unset (localhost use); otherwise require the bearer token."""

    def has_permission(self, request, view):
        token = settings.MARUMADO_TOKEN
        if not token:
            return True
        header = request.headers.get('Authorization', '')
        given = header.removeprefix('Bearer ').strip() or request.query_params.get('token', '')
        return hmac.compare_digest(given, token)
