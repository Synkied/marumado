"""Model APIs (the ModelApi model): an endpoint serving models that a new agent is pointed at instead of its own login.
Ollama, llama.cpp's llama-server, a proxy like LiteLLM, or a provider with an API token.

Claude Code talks Anthropic's Messages API (<root>/v1/messages), Codex OpenAI's Responses API (<root>/v1/responses);
Ollama serves both. The token never goes on the agent's command line, which Herdr types into the pane's shell (so it
would show on screen and in the shell's history): it is set in the environment of the shell Herdr opens for the agent
(`--env` on workspace and tab create), and the agent finds it there.
"""
import json
import re

# The agents that can be pointed at a model API.
AGENT_KINDS = ('claude', 'codex')
MODEL = re.compile(r'^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,199}$')
ENV_KEY = re.compile(r'^[A-Z_][A-Z0-9_]{0,63}$')
CONTROL = re.compile(r'[\x00-\x1f\x7f]')
# Every agent pointed at one gets its name in this variable, so its shell says which API it uses.
MARKER = 'MARUMADO_MODEL_API'
CODEX_TOKEN = 'MARUMADO_API_TOKEN'
CODEX_PROVIDER = 'marumado'


def clean_url(value: str) -> str:
    """An http(s) address without its trailing slash. Raises ValueError."""
    url = value.strip().rstrip('/')
    if not re.match(r'^https?://[^\s/]+', url) or CONTROL.search(url) or len(url) > 300:
        raise ValueError('Use the server address, like http://localhost:11434 or https://api.openai.com/v1.')
    return url


def root(url: str) -> str:
    """The server's root: the address without a trailing /v1, which each agent adds where it needs it."""
    url = url.rstrip('/')
    return url[:-3] if url.endswith('/v1') else url


def check(kind: str, api) -> None:
    """Raises ValueError when a `kind` agent can't be pointed at `api` (a ModelApi, or None)."""
    if api is not None and kind not in AGENT_KINDS:
        raise ValueError(f'Only {" and ".join(AGENT_KINDS)} agents can use a model API like {api.name}.')


def env_for(kind: str, api) -> dict[str, str]:
    """What the shell of a new `kind` agent pointed at `api` has in its environment ({} without one)."""
    if api is None:
        return {}
    check(kind, api)
    if kind == 'claude':
        env = {
            MARKER: api.name,
            'ANTHROPIC_BASE_URL': root(api.base_url),
            # Claude Code asks for a login without a token; a local server takes any.
            'ANTHROPIC_AUTH_TOKEN': api.token or 'marumado',
            # So a key in the shell's environment isn't used instead (and Claude Code doesn't ask which to use).
            'ANTHROPIC_API_KEY': '',
        }
        if api.model:
            # Every model Claude Code would ask for (its main one, its small fast one, its subagents') is this one,
            # since a local server has no Claude models.
            for key in ('ANTHROPIC_MODEL', 'ANTHROPIC_DEFAULT_OPUS_MODEL', 'ANTHROPIC_DEFAULT_SONNET_MODEL',
                        'ANTHROPIC_DEFAULT_HAIKU_MODEL', 'CLAUDE_CODE_SUBAGENT_MODEL'):
                env[key] = api.model
        return env
    return {MARKER: api.name, **({CODEX_TOKEN: api.token} if api.token else {})}


def args_for(kind: str, api) -> list[str]:
    """What a new `kind` agent pointed at `api` is started with, after its command: nothing secret, it shows on screen."""
    if api is None or kind != 'codex':
        return []
    check(kind, api)
    # TOML values (Codex's -c): JSON strings are TOML basic strings.
    provider = {'name': json.dumps(api.name), 'base_url': json.dumps(root(api.base_url) + '/v1'), 'wire_api': '"responses"'}
    if api.token:
        provider['env_key'] = json.dumps(CODEX_TOKEN)
    table = ', '.join(f'{k} = {v}' for k, v in provider.items())
    args = ['-c', f'model_provider="{CODEX_PROVIDER}"', '-c', f'model_providers.{CODEX_PROVIDER}={{{table}}}']
    return [*args, '-m', api.model] if api.model else args


def clean_env(value) -> dict[str, str]:
    """An environment received from another Marumado, checked. Raises ValueError."""
    if value is None:
        return {}
    if not isinstance(value, dict) or len(value) > 16:
        raise ValueError('env is a few NAME: value pairs.')
    for k, v in value.items():
        if not isinstance(k, str) or not ENV_KEY.match(k) or not isinstance(v, str) or len(v) > 4096 or CONTROL.search(v):
            raise ValueError('env is a few NAME: value pairs.')
    return dict(value)


def clean_args(value) -> list[str]:
    """An agent's arguments received from another Marumado, checked. Raises ValueError."""
    if value is None:
        return []
    if not isinstance(value, list) or len(value) > 16 or not all(isinstance(a, str) and len(a) <= 1000 and not CONTROL.search(a) for a in value):
        raise ValueError('args is a short list of text.')
    return list(value)
