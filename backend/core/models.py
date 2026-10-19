from django.db import models


class Project(models.Model):
    SOURCE_SCAN = 'scan'
    SOURCE_MANUAL = 'manual'
    SOURCES = [(SOURCE_SCAN, 'Scanned'), (SOURCE_MANUAL, 'Manual')]
    KIND_PROJECT = 'project'
    KIND_LINK = 'link'
    KINDS = [(KIND_PROJECT, 'Project'), (KIND_LINK, 'Link')]

    name = models.CharField(max_length=120)
    path = models.CharField(max_length=500, blank=True, default='')
    description = models.TextField(blank=True, default='')
    local_url = models.URLField(blank=True, default='')
    online_url = models.URLField(blank=True, default='')
    repo_url = models.URLField(blank=True, default='')
    tags = models.JSONField(default=list, blank=True)
    pinned = models.BooleanField(default=False)
    hidden = models.BooleanField(default=False)
    source = models.CharField(max_length=10, choices=SOURCES, default=SOURCE_MANUAL)
    # A link is a URL watched on its own (a site, a service), not a folder of code.
    kind = models.CharField(max_length=10, choices=KINDS, default=KIND_PROJECT)
    # What the owner decided to do with the project (Momentum). Archiving is `hidden`.
    FOCUS_PUSH = 'push'
    FOCUS_PARK = 'park'
    FOCUSES = [('', 'Undecided'), (FOCUS_PUSH, 'Push'), (FOCUS_PARK, 'Park')]
    focus = models.CharField(max_length=10, choices=FOCUSES, default='', blank=True)
    # The agent source (herdr.Source id) its new agents start in by default; null: the one that has its folder.
    agent_source = models.PositiveIntegerField(null=True, blank=True)
    # Facts found by the scanner (stack, git branch, last commit...). Never edited by hand.
    detected = models.JSONField(default=dict, blank=True)
    # Fields the user changed by hand; the scanner never overwrites these.
    locked_fields = models.JSONField(default=list, blank=True)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ['-pinned', 'name']
        constraints = [
            models.UniqueConstraint(
                fields=['path'], condition=~models.Q(path=''), name='unique_project_path'
            )
        ]

    def __str__(self):
        return self.name


class UptimeCheck(models.Model):
    TARGETS = [('local', 'Local'), ('online', 'Online')]

    project = models.ForeignKey(Project, on_delete=models.CASCADE, related_name='checks')
    target = models.CharField(max_length=10, choices=TARGETS)
    url = models.URLField()
    ok = models.BooleanField()
    status_code = models.PositiveIntegerField(null=True, blank=True)
    latency_ms = models.FloatField(null=True, blank=True)
    error = models.CharField(max_length=300, blank=True, default='')
    checked_at = models.DateTimeField(auto_now_add=True, db_index=True)

    class Meta:
        ordering = ['-checked_at']
        indexes = [models.Index(fields=['project', 'target', '-checked_at'])]


class ScanRoot(models.Model):
    """A folder added in the app whose subfolders are projects (on top of MARUMADO_PROJECT_ROOTS)."""

    path = models.CharField(max_length=500, unique=True)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ['path']

    def __str__(self):
        return self.path


class Skill(models.Model):
    """What the owner wants to do with a skill. Skills themselves come from project stacks and libraries."""

    INTENTS = [('', 'No plan'), ('learn', 'Want to learn'), ('grow', 'Growing'), ('ignore', 'Not a skill')]

    name = models.CharField(max_length=60, unique=True)
    intent = models.CharField(max_length=10, choices=INTENTS, default='', blank=True)
    note = models.TextField(blank=True, default='')
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ['name']

    def __str__(self):
        return self.name


class Machine(models.Model):
    """Another machine running its own Marumado, reached through an SSH tunnel (core/machines.py)."""

    name = models.CharField(max_length=60, unique=True)
    # user@host or a ~/.ssh/config alias. Needs key login (no password prompt).
    ssh_target = models.CharField(max_length=255)
    # The port its Marumado listens on, on its own localhost.
    port = models.PositiveIntegerField(default=7878)
    # Its MARUMADO_TOKEN, when it has one.
    token = models.CharField(max_length=200, blank=True, default='')
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ['name']

    def __str__(self):
        return self.name


class AgentSource(models.Model):
    """Another place Herdr runs (a VM, a server), on top of the one set in .env (core/herdr.py)."""

    SSH = 'ssh'
    SMOLVM = 'smolvm'
    KINDS = [(SSH, 'SSH'), (SMOLVM, 'smolvm machine')]

    name = models.CharField(max_length=60, unique=True)
    kind = models.CharField(max_length=10, choices=KINDS, default=SSH)
    # ssh: user@host, ssh://user@host:port or a ~/.ssh/config alias (key login). smolvm: the machine's name.
    target = models.CharField(max_length=255)
    # Where it sees this machine's folders: [{"here": "/home/me/projects", "there": "/projects"}, …] (see herdr.folder_in).
    folders = models.JSONField(default=list, blank=True)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ['name']

    def __str__(self):
        return self.name


class Setting(models.Model):
    """A setting kept in the database rather than .env, by key: `env_source_folders` (the .env agent source's folders)."""

    key = models.CharField(max_length=60, unique=True)
    value = models.JSONField(default=dict, blank=True)

    def __str__(self):
        return self.key


class Plan(models.Model):
    """Steps for agents to take over on their own, in order or side by side (core/plans.py). Its steps are tasks, laid
    out in rows: a row starts once every step of the row above is finished; the steps of one row run at the same
    time, each on its own agent (in its own git worktree). A step under another continues with that step's agent."""

    title = models.CharField(max_length=200)
    project = models.ForeignKey(Project, null=True, blank=True, on_delete=models.SET_NULL, related_name='plans')
    # What a step that needs a new agent starts, and where (an agent source, as on Task).
    kind = models.CharField(max_length=20, default='claude')
    source = models.PositiveIntegerField(default=0)
    # Steps start by themselves only while the plan runs; paused, those not started yet wait.
    running = models.BooleanField(default=False)
    # When it starts by itself (plans.start_due), if the owner set one and it isn't running yet.
    start_at = models.DateTimeField(null=True, blank=True)
    # An agent's own queue: the plan its steps go into when they are queued from its page (plans.queue_for).
    pane_id = models.CharField(max_length=40, blank=True, default='')
    pane_source = models.PositiveIntegerField(default=0)
    # A command run in a step's folder once its agent finishes (core/checks.py): the rows under it start only once it
    # passes. A failure goes back to the step's agent to fix, up to `check_fixes` times, then the step fails.
    check_command = models.CharField(max_length=500, blank=True, default='')
    check_fixes = models.PositiveSmallIntegerField(default=2)
    # Finished and put away, its steps with it: out of the plans list until restored.
    archived_at = models.DateTimeField(null=True, blank=True)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ['-updated_at']

    def __str__(self):
        return self.title


class Task(models.Model):
    """Something to do, which can be handed to a coding agent in Herdr and followed (core/tasks.py)."""

    TODO = 'todo'
    QUEUED = 'queued'
    STARTING = 'starting'
    WORKING = 'working'
    BLOCKED = 'blocked'
    REVIEW = 'review'
    DONE = 'done'
    FAILED = 'failed'
    STATES = [
        (TODO, 'To do'),
        (QUEUED, 'Queued'),  # a step of a running plan, waiting for the steps above it or for its agent
        (STARTING, 'Starting'),  # being handed to the agent, or sent but not picked up yet
        (WORKING, 'Working'),
        (BLOCKED, 'Needs you'),  # the agent is waiting on an approval or a question
        (REVIEW, 'To review'),  # the agent finished its turn; the owner checks its work
        (DONE, 'Done'),
        (FAILED, 'Failed'),
    ]

    # A short name for lists, made from the prompt unless written by hand.
    title = models.CharField(max_length=200)
    # What the agent is told, in full (empty: the title).
    prompt = models.TextField(blank=True, default='')
    project = models.ForeignKey(Project, null=True, blank=True, on_delete=models.SET_NULL, related_name='tasks')
    state = models.CharField(max_length=10, choices=STATES, default=TODO)
    # The Herdr pane of the agent it was given to, and what that agent was. Pane ids are only unique
    # within one Herdr: `agent_source` says which (0 is the one set in .env, otherwise an AgentSource).
    pane_id = models.CharField(max_length=40, blank=True, default='')
    agent_source = models.PositiveIntegerField(default=0)
    agent_name = models.CharField(max_length=40, blank=True, default='')
    agent_kind = models.CharField(max_length=20, blank=True, default='')
    # The agent's last seen Herdr state (idle, working, blocked, done, unknown) and terminal title.
    agent_state = models.CharField(max_length=10, blank=True, default='')
    agent_title = models.CharField(max_length=200, blank=True, default='')
    # Whether the agent is still being watched.
    live = models.BooleanField(default=False)
    # A plan's step: its row (rows run one after the other) and its place in the row (side by side, at once).
    plan = models.ForeignKey(Plan, null=True, blank=True, on_delete=models.SET_NULL, related_name='steps')
    plan_row = models.PositiveIntegerField(default=0)
    plan_col = models.PositiveIntegerField(default=0)
    # Who takes the step: '' (the agent of the step above it, or a new one), 'new' (always a new agent), or 'agent'
    # (the open agent in want_pane, in want_source).
    RUNNERS = [('', 'Continue'), ('new', 'New agent'), ('agent', 'This agent')]
    runner = models.CharField(max_length=8, blank=True, default='', choices=RUNNERS)
    want_pane = models.CharField(max_length=40, blank=True, default='')
    want_source = models.PositiveIntegerField(default=0)
    # The git branch of the worktree the step's agent works in, when it got one of its own.
    worktree = models.CharField(max_length=120, blank=True, default='')
    # A step that waits for the owner's go when its turn comes (to check the steps above first), and that go.
    ask = models.BooleanField(default=False)
    go = models.BooleanField(default=False)
    # The task is still to be sent: the new agent stopped on a question first (trusting the folder, say).
    prompt_pending = models.BooleanField(default=False)
    # The project's git HEAD when the agent got the task, to show what changed since.
    git_start = models.CharField(max_length=64, blank=True, default='')
    # The folder the agent works in, where Herdr runs, and the record of its session there (core/transcripts.py).
    agent_cwd = models.CharField(max_length=500, blank=True, default='')
    transcript = models.CharField(max_length=500, blank=True, default='')
    # What the agent used for it, from its session record (usage.total), kept as last read.
    usage = models.JSONField(null=True, blank=True)
    # Its plan's check (core/checks.py): '' (none run yet), running, passed, failed, fixing (sent back to the agent
    # with what failed), or skipped (finished before the plan had a check); and how many times it was sent back.
    CHECK_STATES = [('', 'Not run'), ('running', 'Running'), ('passed', 'Passed'), ('failed', 'Failed'), ('fixing', 'Being fixed'),
                    ('skipped', 'Not checked')]  # to review already when its plan got its check
    check_state = models.CharField(max_length=10, blank=True, default='', choices=CHECK_STATES)
    check_tries = models.PositiveSmallIntegerField(default=0)
    # What became of its work (core/land.py): merged into the branch the project is on, or discarded; and the pull
    # request opened for it.
    LANDED = [('', 'Not yet'), ('merged', 'Merged'), ('discarded', 'Discarded')]
    landed = models.CharField(max_length=10, blank=True, default='', choices=LANDED)
    pr_url = models.CharField(max_length=300, blank=True, default='')
    started_at = models.DateTimeField(null=True, blank=True)
    finished_at = models.DateTimeField(null=True, blank=True)
    # Done and put away (or its plan was): off the board and every list until restored.
    archived_at = models.DateTimeField(null=True, blank=True)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ['-updated_at']

    def __str__(self):
        return self.title


class TaskEvent(models.Model):
    """One thing that happened to a task: assigned, a change of the agent's state, what it changed..."""

    KINDS = [
        ('created', 'Created'),
        ('assigned', 'Assigned'),
        ('prompt', 'Prompt sent'),
        ('state', 'Agent state'),
        ('activity', 'Activity'),  # the agent's terminal title changed
        ('changes', 'Changes'),  # commits and files changed in the project since the start
        ('closed', 'Pane closed'),
        ('error', 'Error'),
        ('done', 'Marked done'),
        ('reopened', 'Reopened'),
        ('moved', 'Moved'),  # put under review by hand
        ('archived', 'Archived'),
        ('restored', 'Restored'),  # back from the archive
        ('check', 'Check'),  # its plan's check ran: data {ok, code, seconds, command}, output the end of what it printed
        ('feedback', 'Sent back'),  # the owner (or a failed check) told the agent what to change
        ('merged', 'Merged'),
        ('pr', 'Pull request'),
        ('discarded', 'Discarded'),
    ]

    task = models.ForeignKey(Task, on_delete=models.CASCADE, related_name='events')
    at = models.DateTimeField(auto_now_add=True, db_index=True)
    kind = models.CharField(max_length=10, choices=KINDS)
    # For `state`: the agent's state from this moment on.
    state = models.CharField(max_length=10, blank=True, default='')
    text = models.CharField(max_length=500, blank=True, default='')
    # The end of the agent's terminal at that moment.
    output = models.TextField(blank=True, default='')
    data = models.JSONField(default=dict, blank=True)

    class Meta:
        ordering = ['at', 'id']
