from rest_framework import serializers

from .discovery import SCANNED_FIELDS
from .models import Project, UptimeCheck


class UptimeCheckSerializer(serializers.ModelSerializer):
    class Meta:
        model = UptimeCheck
        fields = ['id', 'target', 'url', 'ok', 'status_code', 'latency_ms', 'error', 'checked_at']


class ProjectSerializer(serializers.ModelSerializer):
    class Meta:
        model = Project
        fields = [
            'id', 'name', 'path', 'description', 'local_url', 'online_url', 'repo_url', 'tags',
            'pinned', 'hidden', 'source', 'kind', 'detected', 'locked_fields', 'created_at', 'updated_at',
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
