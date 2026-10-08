from django.urls import path
from rest_framework.routers import DefaultRouter

from . import views

router = DefaultRouter(trailing_slash=False)
router.register('projects', views.ProjectViewSet, basename='project')
router.register('skills', views.SkillViewSet, basename='skill')
router.register('machines', views.MachineViewSet, basename='machine')
router.register('tasks', views.TaskViewSet, basename='task')
router.register('plans', views.PlanViewSet, basename='plan')
router.register('agent-sources', views.AgentSourceViewSet, basename='agent-source')

urlpatterns = [
    path('auth', views.auth_view),
    path('overview', views.overview_view),
    path('system', views.system),
    path('system/history', views.history),
    path('processes', views.processes),
    path('processes/<int:pid>/kill', views.kill),
    path('ports', views.ports),
    path('docker', views.docker),
    path('docker/<str:cid>/logs', views.docker_logs),
    path('docker/<str:cid>/<str:verb>', views.docker_action),
    path('roots', views.roots),
    path('roots/source', views.root_source),
    path('roots/<int:pk>', views.root_detail),
    path('open', views.open_folder),
    path('files', views.file_list),
    path('files/read', views.file_read),
    path('agents', views.agents),
    path('agents/terminal', views.agent_terminal),
    path('agents/workspace', views.agent_workspace),
    path('agents/workspaces', views.agent_workspaces),
    path('agents/workspaces/<str:workspace_id>/close', views.agent_workspace_close),
    path('agents/start', views.agent_start),
    path('agents/env-source', views.agent_env_source),
    path('agents/trace', views.agent_trace),
    path('agents/pulse', views.agent_pulse),
    path('agents/<str:pane_id>/launch', views.agent_launch),
    path('agents/<str:pane_id>/task', views.agent_task),
    path('agents/<str:pane_id>/queue', views.agent_queue),
    path('agents/<str:pane_id>/output', views.agent_output),
    path('agents/<str:pane_id>/changes', views.agent_changes),
    path('agents/<str:pane_id>/trace', views.agent_conversation),
    path('agents/<str:pane_id>/image', views.agent_image),
    path('agents/<str:pane_id>/input', views.agent_input),
    path('agents/<str:pane_id>/close', views.agent_close),
    path('machines/<int:pk>/retry', views.machine_retry),  # before the proxy, which takes every other path
    path('machines/<int:pk>/<path:rest>', views.machine_proxy),
    *router.urls,
]
