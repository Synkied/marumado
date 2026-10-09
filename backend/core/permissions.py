from rest_framework.exceptions import Throttled
from rest_framework.permissions import BasePermission

from . import auth


class MarumadoToken(BasePermission):
    """A logged-in browser (session cookie), or `Authorization: Bearer <token>`. Always required, localhost included."""

    def has_permission(self, request, view):
        address = request.META.get('REMOTE_ADDR', '')
        given = auth.bearer(request.headers.get('Authorization', ''))
        if given is not None:
            try:
                return auth.try_token(address, given)
            except auth.Locked as exc:
                raise Throttled(detail=str(exc))
        # A valid session is accepted before the wrong-guess lockout is enforced, so wrong tokens from a shared
        # address (a reverse proxy, or a page using DNS rebinding from 127.0.0.1) can't lock the owner's browser out.
        if auth.session_ok(request.session):
            return request.method in auth.SAFE_METHODS or request.headers.get(auth.CSRF_HEADER) == '1'
        try:
            auth.check_locked(address)
        except auth.Locked as exc:
            raise Throttled(detail=str(exc))
        return False
