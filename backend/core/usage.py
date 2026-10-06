"""What an agent's work used: tokens, and what they would cost at API prices, read from its session record.

transcripts.Parser collects one entry per model call as it reads a record: [ms, model, input, cache write 5m,
cache write 1h, cache read, output, fast]. `input` is the input that was neither written to nor read from the cache.
This sums them for a stretch of the session (a task starts at its prompt) and prices them.

Prices are Anthropic's first-party API rates per million tokens (input, output, cache read); a cache write costs 1.25×
input for five minutes, 2× for an hour, and fast mode twice the lot. With a subscription nothing is billed per token:
the cost then says what the work would have cost through the API. Codex reports tokens only, which are not priced.
"""

# (input, output, cache read) in dollars per million tokens, by model id prefix; the longest prefix that fits wins.
PRICES = {
    'claude-fable-5-1': (10.0, 50.0, 0.25),
    'claude-mythos-5-1': (10.0, 50.0, 0.25),
    'claude-fable-5': (10.0, 50.0, 1.0),
    'claude-mythos-5': (10.0, 50.0, 1.0),
    'claude-opus-5-5': (4.0, 20.0, 0.20),
    'claude-opus-5': (5.0, 25.0, 0.50),
    'claude-opus-4-8': (5.0, 25.0, 0.50),
    'claude-opus-4-7': (5.0, 25.0, 0.50),
    'claude-opus-4-6': (5.0, 25.0, 0.50),
    'claude-opus-4-5': (5.0, 25.0, 0.50),
    'claude-opus-4': (15.0, 75.0, 1.50),  # Opus 4 and 4.1
    'claude-sonnet-5-5': (2.0, 10.0, 0.20),
    'claude-sonnet-5': (2.0, 10.0, 0.20),
    'claude-sonnet-4': (3.0, 15.0, 0.30),  # Sonnet 4, 4.5 and 4.6
    'claude-haiku-4-5': (1.0, 5.0, 0.10),
    'claude-3-5-haiku': (0.80, 4.0, 0.08),
}
_BY_LENGTH = sorted(PRICES, key=len, reverse=True)

# The fields of an entry, after its time and model.
FIELDS = ('input', 'cache_write', 'cache_write_1h', 'cache_read', 'output')


def price(model: str) -> tuple[float, float, float] | None:
    return next((PRICES[p] for p in _BY_LENGTH if model.startswith(p)), None)


def cost(entry: list) -> float | None:
    """What one model call costs at API prices; None for a model without a known price."""
    rates = price(entry[1] or '')
    if rates is None:
        return None
    inp, out, read = rates
    _, _, fresh, write, write_1h, cached, output, fast = entry
    dollars = (fresh * inp + write * inp * 1.25 + write_1h * inp * 2 + cached * read + output * out) / 1_000_000
    return dollars * 2 if fast else dollars


def total(entries, context: dict | None = None) -> dict:
    """The sum of `entries`: tokens by kind, the cost of the priced ones (`priced`: whether every one was), the models,
    and `context` as given (how full the agent's context is)."""
    tokens = dict.fromkeys(FIELDS, 0)
    dollars, priced, models, calls = 0.0, True, [], 0
    for e in entries:
        calls += 1
        for i, field in enumerate(FIELDS):
            tokens[field] += e[2 + i]
        c = cost(e)
        if c is None:
            priced = False
        else:
            dollars += c
        if e[1] and e[1] not in models:
            models.append(e[1])
    return {'calls': calls, 'tokens': tokens, 'total': sum(tokens.values()), 'cost': round(dollars, 4) if calls else 0.0,
            'priced': priced, 'models': models, 'context': context}


def add(a: dict | None, b: dict | None) -> dict | None:
    """Two totals as one (a plan's steps, say), without a context: that belongs to one agent."""
    if not a or not a.get('calls'):
        return {**b, 'context': None} if b and b.get('calls') else None
    if not b or not b.get('calls'):
        return {**a, 'context': None}
    tokens = {f: a['tokens'].get(f, 0) + b['tokens'].get(f, 0) for f in FIELDS}
    return {'calls': a['calls'] + b['calls'], 'tokens': tokens, 'total': sum(tokens.values()),
            'cost': round(a['cost'] + b['cost'], 4), 'priced': a['priced'] and b['priced'],
            'models': list(dict.fromkeys([*a['models'], *b['models']])), 'context': None}
