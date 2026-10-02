from rest_framework.exceptions import Throttled
from rest_framework.permissions import BasePermission

from . import auth


class MarumadoToken(BasePermission):
    """A logged-in browser (session cookie), or `Authorization: Bearer <token>`. Always required, localhost included."""

    def has_permission(self, request, view):
        address = request.META.get('REMOTE_ADDR', '')
        given = auth.bearer(request.headers.get('Authorization', ''))
        try:
            if given is not None:
                return auth.try_token(address, given)
            auth.check_locked(address)
        except auth.Locked as exc:
            raise Throttled(detail=str(exc))
        if not auth.session_ok(request.session):
            return False
        return request.method in auth.SAFE_METHODS or request.headers.get(auth.CSRF_HEADER) == '1'
