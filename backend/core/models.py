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


class Task(models.Model):
    """Something to do, which can be handed to a coding agent in Herdr and followed (core/tasks.py)."""

    TODO = 'todo'
    STARTING = 'starting'
    WORKING = 'working'
    BLOCKED = 'blocked'
    REVIEW = 'review'
    DONE = 'done'
    FAILED = 'failed'
    STATES = [
        (TODO, 'To do'),
        (STARTING, 'Starting'),  # being handed to the agent, or sent but not picked up yet
        (WORKING, 'Working'),
        (BLOCKED, 'Needs you'),  # the agent is waiting on an approval or a question
        (REVIEW, 'To review'),  # the agent finished its turn; the owner checks its work
        (DONE, 'Done'),
        (FAILED, 'Failed'),
    ]

    title = models.CharField(max_length=200)
    # What the agent is told, after the title.
    notes = models.TextField(blank=True, default='')
    project = models.ForeignKey(Project, null=True, blank=True, on_delete=models.SET_NULL, related_name='tasks')
    state = models.CharField(max_length=10, choices=STATES, default=TODO)
    # The Herdr pane of the agent it was given to, and what that agent was.
    pane_id = models.CharField(max_length=40, blank=True, default='')
    agent_name = models.CharField(max_length=40, blank=True, default='')
    agent_kind = models.CharField(max_length=20, blank=True, default='')
    # The agent's last seen Herdr state (idle, working, blocked, done, unknown) and terminal title.
    agent_state = models.CharField(max_length=10, blank=True, default='')
    agent_title = models.CharField(max_length=200, blank=True, default='')
    # Whether the agent is still being watched.
    live = models.BooleanField(default=False)
    # The task is still to be sent: the new agent stopped on a question first (trusting the folder, say).
    prompt_pending = models.BooleanField(default=False)
    # The project's git HEAD when the agent got the task, to show what changed since.
    git_start = models.CharField(max_length=64, blank=True, default='')
    started_at = models.DateTimeField(null=True, blank=True)
    finished_at = models.DateTimeField(null=True, blank=True)
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
