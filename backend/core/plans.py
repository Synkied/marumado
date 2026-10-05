"""Plans: steps for coding agents to take over on their own (models.Plan).

A plan's steps are tasks laid out in rows. While the plan runs, the monitor calls advance() after tasks.watch():
a row's steps start once every step of the rows above it is finished (to review, or done), all of a row's at once.
Who takes a step:
- runner '' (the default): the agent of the step above it (at the same place in the row above), so it keeps that
  agent's context and folder. A step of the first row, one past the width of the row above, or one whose agent was
  closed, gets a new agent;
- 'new': a new agent of the plan's kind, where the plan says;
- 'agent': the open agent chosen for it.
A new agent for a step that runs beside others gets a git worktree of the project, on a branch of its own, so they
don't write over each other; the steps under it continue there. Merging is the owner's.
An agent takes a step only when it is free (idle at its prompt, or finished its turn): one at work, or waiting on
the owner, keeps the step queued. A failed step holds back the rows under it; the rest of its row carries on.
A step marked `ask` doesn't start by itself: when its turn comes it waits for the owner's go (go()), so they can
check the steps above it first.
An agent's own queue is a plan too (queue_for): steps queued from the agent's page, one row each, all on that agent.
"""
import logging
import re
from itertools import groupby
from pathlib import Path

from django.db import transaction

from . import herdr, tasks
from .models import Plan, Task

log = logging.getLogger(__name__)

FINISHED = (Task.REVIEW, Task.DONE)
FREE = ('idle', 'done')


def rows(plan: Plan, steps: list[Task] | None = None) -> list[list[Task]]:
    steps = sorted(plan.steps.all() if steps is None else steps, key=lambda t: (t.plan_row, t.plan_col, t.id))
    return [list(row) for _, row in groupby(steps, key=lambda t: t.plan_row)]


def above(step: Task, layout: list[list[Task]]) -> Task | None:
    """The step whose agent this one continues with: the one at the same place in the row above, if any."""
    for i, row in enumerate(layout):
        if step in row:
            at = row.index(step)
            return layout[i - 1][at] if i and at < len(layout[i - 1]) else None
    return None


def expected_agent(step: Task, layout: list[list[Task]]) -> tuple[int, str] | None:
    """(source, pane) of the open agent the step will go to, or None when it will get a new one."""
    if step.runner == 'agent':
        return (step.want_source, step.want_pane) if step.want_pane else None
    if step.runner == 'new':
        return None
    prev = above(step, layout)
    if prev is None:
        return None
    if prev.pane_id:
        return (prev.agent_source, prev.pane_id)
    return expected_agent(prev, layout)


def branch_for(step: Task) -> str:
    slug = re.sub(r'[^a-z0-9]+', '-', step.title.lower()).strip('-')[:32].strip('-') or 'step'
    return f'marumado/p{step.plan_id}-{step.id}-{slug}'


def asking(plan: Plan, layout: list[list[Task]]) -> set[int]:
    """The steps whose turn has come but that wait for the owner's go."""
    out = set()
    if not plan.running:
        return out
    for row in layout:
        out |= {t.id for t in row if t.state == Task.QUEUED and t.ask and not t.go}
        if not all(t.state in FINISHED for t in row):
            break
    return out


def queued_for_agents() -> dict[tuple[int, str], list[Task]]:
    """The steps waiting for each open agent, in the order it will take them; `asking` on each says whether it waits
    for the owner's go."""
    out: dict[tuple[int, str], list[Task]] = {}
    for plan in Plan.objects.filter(steps__state=Task.QUEUED).distinct().prefetch_related('steps'):
        layout = rows(plan)
        waiting = asking(plan, layout)
        for row in layout:
            for step in row:
                if step.state == Task.QUEUED and (who := expected_agent(step, layout)):
                    step.asking = step.id in waiting
                    out.setdefault(who, []).append(step)
    return out


# ---------------------------------------------------------------- running

def advance() -> None:
    """Start every step whose turn has come, in every running plan."""
    plans = list(Plan.objects.filter(running=True, steps__state=Task.QUEUED).distinct().select_related('project'))
    if not plans:
        return
    listed = herdr.agents()
    unreachable = {s['id'] for s in listed['sources'] if not s['available']}
    agents = {(a['source'], a['pane_id']): a for a in listed['agents'] if a['kind'] != 'terminal'}
    taken: set[tuple[int, str]] = set()  # agents given a step in this pass
    for plan in plans:
        try:
            _advance(plan, agents, unreachable, taken)
        except Exception:
            log.exception('advancing plan %s failed', plan.id)


def _advance(plan: Plan, agents: dict, unreachable: set[int], taken: set) -> None:
    layout = rows(plan, list(plan.steps.select_related('project', 'plan')))
    for row in layout:
        for step in row:
            if step.state == Task.QUEUED:
                _try(plan, step, row, layout, agents, unreachable, taken)
        if not all(t.state in FINISHED for t in row):
            return  # the rows under it wait


def _try(plan: Plan, step: Task, row: list[Task], layout: list[list[Task]], agents: dict, unreachable: set[int], taken: set) -> None:
    with tasks._lock:
        if step.id in tasks._assigning:
            return
    if step.ask and not step.go:
        return  # its turn has come: it waits for the owner's go
    who, worktree = None, ''
    if step.runner == 'agent':
        who = (step.want_source, step.want_pane)
        if who[0] in unreachable:
            return
        if who not in agents:
            return _fail(step, 'The agent chosen for this step was closed.')
    elif step.runner == '':
        prev = above(step, layout)
        if prev and prev.pane_id and (prev.agent_source, prev.pane_id) in agents:
            who, worktree = (prev.agent_source, prev.pane_id), prev.worktree
        elif prev and prev.pane_id and prev.agent_source in unreachable:
            return  # its agent may well still be there
    try:
        if who:
            agent = agents[who]
            if agent['status'] not in FREE or who in taken:
                return  # at work, or waiting on you: the step waits for it
            following = Task.objects.filter(live=True, agent_source=who[0], pane_id=who[1]).exclude(pk=step.pk)
            if following.exclude(state__in=FINISHED).exists():
                return  # still on a task given to it by hand
            # The step it finished (or any other under review) stops following it: the agent moves on to this one.
            following.update(live=False)
            taken.add(who)
            tasks.assign(step, who[1], source=who[0], worktree=worktree)
        else:
            if plan.source in unreachable:
                return
            if len(row) > 1 and _has_repo(step, plan.source):
                worktree = branch_for(step)
            tasks.assign(step, kind=plan.kind, source=plan.source, worktree=worktree)
    except (ValueError, RuntimeError) as exc:
        _fail(step, f"Couldn't start it: {exc}")


def _has_repo(step: Task, source: int) -> bool:
    """Whether the step's project is a git repository a worktree can be made of. Another machine's copy can't be
    checked from here: assumed so, and the step fails with the reason if it isn't."""
    if not step.project or not step.project.path:
        return False
    return source >= herdr.MACHINE_BASE or (Path(step.project.path) / '.git').exists()


def _fail(step: Task, text: str) -> None:
    step.state, step.finished_at = Task.FAILED, tasks._now()
    step.save(update_fields=['state', 'finished_at', 'updated_at'])
    tasks.event(step, 'error', text)


# ---------------------------------------------------------------- the owner's actions

def arrange(plan: Plan, layout: list[list[int]]) -> None:
    """Lay the plan's steps out as `layout` (rows of task ids). Tasks it takes in join the plan; steps it leaves out
    go back to the ideas."""
    ids = [i for row in layout for i in row]
    if len(set(ids)) != len(ids):
        raise ValueError('A step can only be in one place.')
    found = {t.id: t for t in Task.objects.filter(id__in=ids)}
    if len(found) != len(ids):
        raise ValueError('Some of those tasks no longer exist.')
    for t in found.values():
        if t.plan_id not in (None, plan.id):
            raise ValueError(f'“{t.title}” is in another plan.')
    with transaction.atomic():
        for t in plan.steps.exclude(id__in=ids):
            t.plan = None
            if t.state == Task.QUEUED:
                t.state = Task.TODO
            t.save(update_fields=['plan', 'state', 'updated_at'])
        for r, row in enumerate(r for r in layout if r):
            for c, i in enumerate(row):
                t = found[i]
                t.plan, t.plan_row, t.plan_col = plan, r, c
                if t.state == Task.TODO and plan.running:
                    t.state = Task.QUEUED
                t.save(update_fields=['plan', 'plan_row', 'plan_col', 'state', 'updated_at'])
        plan.save(update_fields=['updated_at'])


def start(plan: Plan) -> None:
    """Let the plan run: its steps still to do are queued, and start as their turn comes."""
    with transaction.atomic():
        plan.running = True
        plan.save(update_fields=['running', 'updated_at'])
        for t in plan.steps.filter(state=Task.TODO):
            t.state = Task.QUEUED
            t.save(update_fields=['state', 'updated_at'])
            tasks.event(t, 'moved', f'Queued in “{plan.title}”')


def go(step: Task) -> None:
    """The owner's go for a step that asks for it: it starts as soon as its agent is free."""
    step.go = True
    step.save(update_fields=['go', 'updated_at'])
    tasks.event(step, 'moved', 'Go given')


def queue_for(source: int, pane_id: str, agent: dict, project, title: str, notes: str = '', ask: bool = False) -> Task:
    """Queue a step on an open agent: into its own queue (a plan made for it the first time), after what is already
    queued there. It starts when the agent is free and the steps before it are finished."""
    with transaction.atomic():
        plan = Plan.objects.filter(pane_id=pane_id, pane_source=source).order_by('-id').first()
        if plan is None:
            name = agent.get('name') or agent.get('kind') or pane_id
            plan = Plan.objects.create(
                title=f'Next for {name}'[:200], project=project, source=source, running=True, pane_id=pane_id, pane_source=source,
                kind=agent['kind'] if agent.get('kind') in herdr.AGENT_KINDS else 'claude',
            )
        step = Task.objects.create(title=title, notes=notes, project=plan.project or project, runner='agent', want_pane=pane_id,
                                   want_source=source, ask=ask)
        tasks.event(step, 'created', f'Queued for {agent.get("name") or agent.get("kind") or pane_id}')
        arrange(plan, [[t.id for t in row] for row in rows(plan)] + [[step.id]])
    step.refresh_from_db()
    return step


def pause(plan: Plan) -> None:
    """Nothing more starts; the steps at work carry on."""
    plan.running = False
    plan.save(update_fields=['running', 'updated_at'])


def dissolve(plan: Plan) -> None:
    """Before deleting the plan: its steps go back to the ideas, keeping their history."""
    for t in plan.steps.all():
        t.plan = None
        if t.state == Task.QUEUED:
            t.state = Task.TODO
        t.save(update_fields=['plan', 'state', 'updated_at'])
