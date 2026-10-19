from rest_framework import serializers

from .discovery import SCANNED_FIELDS
from . import herdr, machines, tasks
from .models import AgentSource, Machine, Plan, Project, Skill, Task, TaskEvent, UptimeCheck


class UptimeCheckSerializer(serializers.ModelSerializer):
    class Meta:
        model = UptimeCheck
        fields = ['id', 'target', 'url', 'ok', 'status_code', 'latency_ms', 'error', 'checked_at']


class ProjectSerializer(serializers.ModelSerializer):
    # The default agent source of the scan folder it is in (its own agent_source comes first).
    folder_source = serializers.SerializerMethodField()

    class Meta:
        model = Project
        fields = [
            'id', 'name', 'path', 'description', 'local_url', 'online_url', 'repo_url', 'tags',
            'pinned', 'hidden', 'source', 'kind', 'focus', 'agent_source', 'folder_source', 'detected', 'locked_fields', 'created_at', 'updated_at',
        ]
        read_only_fields = ['source', 'detected', 'locked_fields', 'created_at', 'updated_at']

    def validate_tags(self, value):
        if not isinstance(value, list) or not all(isinstance(t, str) for t in value):
            raise serializers.ValidationError('Tags must be a list of strings.')
        return [t.strip()[:40] for t in value if t.strip()][:12]

    def get_folder_source(self, project) -> int | None:
        # Read once per request when serializing a list (the context is shared).
        if 'folder_sources' not in self.context:
            self.context['folder_sources'] = herdr.folder_sources()
        return herdr.source_of_folder(project.path, self.context['folder_sources'])

    def validate_agent_source(self, value):
        if value is None:
            return None
        try:
            herdr.get_source(value)
        except ValueError as exc:
            raise serializers.ValidationError(str(exc))
        return value

    def update(self, instance, validated_data):
        # Remember hand edits so the next scan doesn't overwrite them.
        locked = set(instance.locked_fields)
        for field in SCANNED_FIELDS:
            if field in validated_data and validated_data[field] != getattr(instance, field):
                locked.add(field)
        instance.locked_fields = sorted(locked)
        return super().update(instance, validated_data)


class SkillSerializer(serializers.ModelSerializer):
    class Meta:
        model = Skill
        fields = ['id', 'name', 'intent', 'note', 'created_at', 'updated_at']
        read_only_fields = ['created_at', 'updated_at']

    def validate_name(self, value):
        name = value.strip()
        if not name:
            raise serializers.ValidationError('Enter a skill name.')
        clash = Skill.objects.filter(name__iexact=name)
        if self.instance:
            clash = clash.exclude(pk=self.instance.pk)
        if clash.exists():
            raise serializers.ValidationError(f'“{name}” is already on your list.')
        return name


class AgentSourceSerializer(serializers.ModelSerializer):
    class Meta:
        model = AgentSource
        fields = ['id', 'name', 'kind', 'target', 'folders']

    def validate_folders(self, value):
        try:
            return herdr.clean_folders(value)
        except ValueError as exc:
            raise serializers.ValidationError(str(exc))

    def validate_name(self, value):
        value = value.strip()
        if not value:
            raise serializers.ValidationError('Give it a name.')
        return value

    def validate(self, data):
        kind = data.get('kind', self.instance.kind if self.instance else AgentSource.SSH)
        target = data.get('target', self.instance.target if self.instance else '').strip()
        if not herdr.valid_target(kind, target):
            raise serializers.ValidationError({'target': 'Use user@host, ssh://user@host:port, a host name, or an alias from ~/.ssh/config.'
                                               if kind == AgentSource.SSH else 'Use the smolvm machine name (letters, digits, . _ -).'})
        return {**data, 'target': target}


class MachineSerializer(serializers.ModelSerializer):
    class Meta:
        model = Machine
        fields = ['id', 'name', 'ssh_target', 'port', 'token']
        extra_kwargs = {'token': {'write_only': True}}

    def validate_ssh_target(self, value):
        value = value.strip()
        if not machines.valid_target(value):
            raise serializers.ValidationError('Use user@host, ssh://user@host:port, a host name, or an alias from ~/.ssh/config.')
        return value


class TaskEventSerializer(serializers.ModelSerializer):
    class Meta:
        model = TaskEvent
        fields = ['id', 'at', 'kind', 'state', 'text', 'output', 'data']


class TaskSerializer(serializers.ModelSerializer):
    project_name = serializers.CharField(source='project.name', read_only=True, default='')
    # Left blank, it is made from the prompt.
    title = serializers.CharField(max_length=200, required=False, allow_blank=True)

    class Meta:
        model = Task
        fields = [
            'id', 'title', 'prompt', 'project', 'project_name', 'state', 'pane_id', 'agent_source', 'agent_name', 'agent_kind',
            'agent_state', 'agent_title', 'live', 'prompt_pending', 'started_at', 'finished_at', 'archived_at', 'created_at', 'updated_at',
            'plan', 'plan_row', 'plan_col', 'runner', 'want_pane', 'want_source', 'worktree', 'ask', 'go',
            'usage', 'check_state', 'check_tries', 'landed', 'pr_url',
        ]
        read_only_fields = [f for f in fields if f not in ('title', 'prompt', 'project', 'runner', 'want_pane', 'want_source', 'ask')]

    def validate(self, attrs):
        runner = attrs.get('runner', getattr(self.instance, 'runner', ''))
        if runner == 'agent' and not attrs.get('want_pane', getattr(self.instance, 'want_pane', '')):
            raise serializers.ValidationError({'want_pane': 'Choose the agent to give it to.'})
        if attrs.get('want_pane') and not herdr.PANE_ID.match(attrs['want_pane']):
            raise serializers.ValidationError({'want_pane': 'Not a Herdr pane id.'})
        if 'title' in attrs or not self.instance:
            prompt = attrs.get('prompt', self.instance.prompt if self.instance else '')
            attrs['title'] = attrs.get('title', '').strip() or tasks.title_from(prompt)
            if not attrs['title']:
                raise serializers.ValidationError({'prompt': 'Write what needs doing.'})
        return attrs


class PlanSerializer(serializers.ModelSerializer):
    project_name = serializers.CharField(source='project.name', read_only=True, default='')
    steps = serializers.SerializerMethodField()
    asking = serializers.SerializerMethodField()
    usage = serializers.SerializerMethodField()
    check_command = serializers.CharField(max_length=500, required=False, allow_blank=True, trim_whitespace=True)
    check_fixes = serializers.IntegerField(required=False, min_value=0, max_value=5)

    class Meta:
        model = Plan
        fields = ['id', 'title', 'project', 'project_name', 'kind', 'source', 'running', 'start_at', 'pane_id', 'pane_source', 'archived_at', 'created_at',
                  'updated_at', 'steps', 'asking', 'usage', 'check_command', 'check_fixes']
        read_only_fields = ['running', 'pane_id', 'pane_source', 'archived_at', 'created_at', 'updated_at', 'steps', 'asking', 'usage']

    def get_usage(self, plan):
        """What its steps' agents used, all together."""
        from .usage import add

        total = None
        for t in plan.steps.all():
            total = add(total, t.usage)
        return total

    def get_steps(self, plan):
        """Row by row, left to right."""
        return TaskSerializer(sorted(plan.steps.all(), key=lambda t: (t.plan_row, t.plan_col, t.id)), many=True).data

    def get_asking(self, plan):
        """The steps whose turn has come, waiting for the owner's go."""
        from .plans import asking, rows

        return sorted(asking(plan, rows(plan)))

    def validate_title(self, value):
        value = value.strip()
        if not value:
            raise serializers.ValidationError('Name the plan.')
        return value

    def validate_kind(self, value):
        if value not in herdr.AGENT_KINDS:
            raise serializers.ValidationError('Herdr cannot start that kind of agent.')
        return value

    def validate_source(self, value):
        try:
            herdr.get_source(value)
        except ValueError as exc:
            raise serializers.ValidationError(str(exc))
        return value

    def validate_start_at(self, value):
        """A time to come, for a plan that isn't running yet; none takes it off."""
        if value is None:
            return value
        if self.instance and self.instance.running:
            raise serializers.ValidationError('It is already running.')
        if value <= tasks._now():
            raise serializers.ValidationError('Pick a time still to come.')
        return value
