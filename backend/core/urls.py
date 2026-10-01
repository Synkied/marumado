from django.urls import path
from rest_framework.routers import DefaultRouter

from . import views

router = DefaultRouter(trailing_slash=False)
router.register('projects', views.ProjectViewSet, basename='project')
router.register('skills', views.SkillViewSet, basename='skill')
router.register('machines', views.MachineViewSet, basename='machine')

urlpatterns = [
    path('overview', views.overview),
    path('system', views.system),
    path('system/history', views.history),
    path('processes', views.processes),
    path('processes/<int:pid>/kill', views.kill),
    path('ports', views.ports),
    path('docker', views.docker),
    path('docker/<str:cid>/logs', views.docker_logs),
    path('docker/<str:cid>/<str:verb>', views.docker_action),
    path('roots', views.roots),
    path('roots/<int:pk>', views.root_detail),
    path('open', views.open_folder),
    path('agents', views.agents),
    path('agents/<str:pane_id>/output', views.agent_output),
    path('agents/<str:pane_id>/input', views.agent_input),
    path('machines/<int:pk>/<path:rest>', views.machine_proxy),
    *router.urls,
]
