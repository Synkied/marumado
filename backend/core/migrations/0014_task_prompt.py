import re

from django.db import migrations

TITLE_LENGTH = 80


def title_from(prompt):
    """core.tasks.title_from as it was written with this migration."""
    line = next((x for x in prompt.splitlines() if x.strip()), '')
    line = ' '.join(re.sub(r'^\s*(?:[#>*-]+|\d+[.)])\s*', '', line).split())
    sentence = re.match(r'(.+?)[.!?:;](?:\s|$)', line)
    if sentence and len(sentence.group(1)) <= TITLE_LENGTH:
        return sentence.group(1)
    if len(line) <= TITLE_LENGTH:
        return line
    cut = line[:TITLE_LENGTH - 1]
    return (cut.rsplit(' ', 1)[0] if ' ' in cut else cut).rstrip(',;:-–— ') + '…'


def fold_title(apps, schema_editor):
    """The agent used to be told the title, then the notes: the prompt is now all of it. A title that was a whole
    prompt (too long for a list) becomes that prompt, under a short title made from it."""
    Task = apps.get_model('core', 'Task')
    for task in Task.objects.all():
        if task.prompt:
            task.prompt = f'{task.title}\n\n{task.prompt.strip()}'
        elif len(task.title) > TITLE_LENGTH:
            task.prompt, task.title = task.title, title_from(task.title) or task.title[:TITLE_LENGTH]
        else:
            continue
        task.save(update_fields=['prompt', 'title'])


def split_title(apps, schema_editor):
    Task = apps.get_model('core', 'Task')
    for task in Task.objects.exclude(prompt=''):
        head, _, rest = task.prompt.partition('\n\n')
        task.prompt = rest if head == task.title else task.prompt
        task.save(update_fields=['prompt'])


class Migration(migrations.Migration):

    dependencies = [
        ('core', '0013_plan_asks'),
    ]

    operations = [
        migrations.RenameField(model_name='task', old_name='notes', new_name='prompt'),
        migrations.RunPython(fold_title, split_title),
    ]
