from . import monitor


class StartMonitor:
    """Start the sampler threads on the first API request, in whichever server process handles it."""

    def __init__(self, get_response):
        self.get_response = get_response

    def __call__(self, request):
        if request.path.startswith('/api/'):
            monitor.ensure_started()
        return self.get_response(request)
