from rest_framework import serializers

from .discovery import SCANNED_FIELDS
from . import machines
from .models import Machine, Project, Skill, Task, TaskEvent, UptimeCheck


class UptimeCheckSerializer(serializers.ModelSerializer):
    class Meta:
        model = UptimeCheck
        fields = ['id', 'target', 'url', 'ok', 'status_code', 'latency_ms', 'error', 'checked_at']


class ProjectSerializer(serializers.ModelSerializer):
    class Meta:
        model = Project
        fields = [
            'id', 'name', 'path', 'description', 'local_url', 'online_url', 'repo_url', 'tags',
            'pinned', 'hidden', 'source', 'kind', 'focus', 'detected', 'locked_fields', 'created_at', 'updated_at',
        ]
        read_only_fields = ['source', 'detected', 'locked_fields', 'created_at', 'updated_at']

    def validate_tags(self, value):
        if not isinstance(value, list) or not all(isinstance(t, str) for t in value):
            raise serializers.ValidationError('Tags must be a list of strings.')
        return [t.strip()[:40] for t in value if t.strip()][:12]

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

    class Meta:
        model = Task
        fields = [
            'id', 'title', 'notes', 'project', 'project_name', 'state', 'pane_id', 'agent_name', 'agent_kind',
            'agent_state', 'agent_title', 'live', 'prompt_pending', 'started_at', 'finished_at', 'created_at', 'updated_at',
        ]
        read_only_fields = [f for f in fields if f not in ('title', 'notes', 'project')]

    def validate_title(self, value):
        value = value.strip()
        if not value:
            raise serializers.ValidationError('Write what needs doing.')
        return value
