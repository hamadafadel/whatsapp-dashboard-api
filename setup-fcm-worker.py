#!/usr/bin/env python3
"""Operator-run on the Coolify SERVER; never runs an FCM sender or restarts production.

Requires root/Docker, Python 3, Docker Compose v2, HTTPS access to Coolify/GitHub,
and a Coolify API token entered through /dev/tty. No token in argv/environment.
"""
import base64
import fcntl
import getpass
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import stat
import subprocess
import sys
import tempfile
import urllib.error
import urllib.request

BASE = 'https://coolify.almehrab.org/api/v1'
API_APP = 'mm88aewbk82d42ss62l1qfr2'
WORKER_APP = 'a86mdjp3umlr521t25nptmi1'
REPOSITORY = 'hamadafadel/whatsapp-dashboard-api'
TARGET = '/run/secrets/firebase-service-account.json'
REQUIRED = ['DB_HOST', 'DB_NAME', 'DB_USER', 'DB_PASSWORD', 'FIREBASE_PROJECT_ID',
            'ANDROID_PUSH_TOKEN_ENCRYPTION_KEY', 'GOOGLE_APPLICATION_CREDENTIALS', 'DASHBOARD_USERNAME']
OPTIONAL = ['DASHBOARD_' + role + '_' + suffix for role in ['AGENT1', 'CONFIRMATION', 'GALLERY']
            for suffix in ['USERNAME', 'PASSWORD']]
# Reviewed source hashes are filled when preparing this script, not discovered from arbitrary code.
SOURCE_HASHES = {
    'compose.fcm-worker.yaml': '9fcc3e5c4ca5383d337d4bb70ec509db4827c66fd655c79de1c1b707f5ef3923',
    'Dockerfile.fcm-worker': 'b80066d237ca58faff77456ddfd3e5ce2809015f3221d9158938903a9c7dc2fa',
    'package.json': '3d795d6a14d8aae0ff508c0bbef43255994e4a27ddb064a5276fbbfbba3abc1b',
    'package-lock.json': '70144c16f4f6628a826197778b2bb21e8174108974b8d96b138fc94612227daa',
    'android-push.js': '2f2aacd93e140c9458a3d53d9dd78173b8ab416c7a14b5aa2f8f4437852cd5ba',
    'android-push-store.js': 'b828765ebd78d6675cc935e7484f54b3633a3d705a6e1cd478566e098021075c',
    'android-push-worker.js': '29efe018ac7229d1ee775dc4618085f04dc877af601be0440f215caab5b3978d',
    'android-push-preflight.js': '70686f7415405fbe941b74a23ac51b5ba6905d1a4030cb45b1303ff1e23472a7',
    'android-push-worker-access.js': '7e0be1526773f2ab6078301a5111c8b5ea3edb766d29cf6027171cee23dd77d1',
    'android-push-service.js': 'baf30b337afbb907e3c85523a5b763b553d1d4d2b6f8ccae901086db5dc2ea88',
}

class Stop(Exception):
    pass

def require(condition, code):
    if not condition:
        raise Stop(code)

class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        raise Stop('HTTP_REDIRECT_REFUSED')

def http_json(url, token=None, method='GET', body=None):
    require(url.startswith(BASE + '/') if token else url.startswith('https://api.github.com/'), 'HTTP_DESTINATION_REFUSED')
    headers = {'Accept': 'application/json', 'User-Agent': 'Mehrab-FCM-readiness-setup'}
    if token:
        headers['Authorization'] = 'Bearer ' + token
    data = None if body is None else json.dumps(body).encode()
    if data is not None:
        headers['Content-Type'] = 'application/json'
    request = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        with urllib.request.build_opener(NoRedirect()).open(request, timeout=30) as response:
            return json.load(response)
    except urllib.error.HTTPError as error:
        raise Stop('HTTP_STATUS_' + str(error.code) + '_' + method) from None
    except (urllib.error.URLError, ValueError):
        raise Stop('HTTP_REQUEST_FAILED_' + method) from None

def command(argv, env=None, timeout=30):
    try:
        result = subprocess.run(argv, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                env=env, timeout=timeout, check=False)
    except (OSError, subprocess.TimeoutExpired):
        raise Stop('LOCAL_COMMAND_UNAVAILABLE_OR_TIMEOUT') from None
    require(result.returncode == 0, 'LOCAL_COMMAND_FAILED')
    return result.stdout.decode('utf-8')

def coolify_api(token, path, method='GET', body=None):
    allowed = ['/applications/' + API_APP, '/applications/' + WORKER_APP]
    if method == 'GET':
        require(path in allowed, 'API_READ_SCOPE_REFUSED')
    else:
        require(method == 'PATCH' and path in ['/applications/' + WORKER_APP,
                '/applications/' + WORKER_APP + '/envs/bulk'], 'API_WRITE_SCOPE_REFUSED')
    return http_json(BASE + path, token, method, body)

def belongs(container, uuid):
    pattern = re.compile(r'(?<![A-Za-z0-9])' + re.escape(uuid) + r'(?![A-Za-z0-9])')
    return bool(pattern.search(container.get('Name', ''))) or any(
        pattern.search(str(v)) for v in (container.get('Config', {}).get('Labels') or {}).values())

def environment(container):
    result = {}
    for item in container['Config'].get('Env', []):
        key, sep, value = item.partition('=')
        require(bool(sep), 'INVALID_BACKEND_ENVIRONMENT')
        require(key not in result or result[key] == value, 'AMBIGUOUS_BACKEND_ENVIRONMENT')
        result[key] = value
    for key in REQUIRED:
        require(bool(result.get(key)), 'BACKEND_REQUIRED_SETTING_MISSING_' + key)
    require(result['FIREBASE_PROJECT_ID'] == 'al-mehrab-dashboard-231aa', 'FIREBASE_PROJECT_MISMATCH')
    try:
        require(len(base64.b64decode(result['ANDROID_PUSH_TOKEN_ENCRYPTION_KEY'], validate=True)) == 32, 'INVALID_ENCRYPTION_KEY')
    except ValueError:
        raise Stop('INVALID_ENCRYPTION_KEY') from None
    selected = {key: result.get(key, '') for key in REQUIRED + OPTIONAL}
    selected['DB_PORT'] = result.get('DB_PORT') or '5432'
    require(selected['DB_PORT'].isdigit(), 'INVALID_DATABASE_PORT')
    for role in ['AGENT1', 'CONFIRMATION', 'GALLERY']:
        prefix = 'DASHBOARD_' + role
        require(bool(selected[prefix + '_USERNAME']) == bool(selected[prefix + '_PASSWORD']), 'INCOMPLETE_DASHBOARD_ACCOUNT_PAIR')
    return selected

def discover_mount(container, credential_path):
    require(credential_path.startswith('/'), 'CREDENTIAL_PATH_NOT_ABSOLUTE')
    candidates = []
    for mount in container.get('Mounts', []):
        destination = mount['Destination'].rstrip('/')
        if credential_path == destination or credential_path.startswith(destination + '/'):
            candidates.append(mount)
    require(bool(candidates), 'FIREBASE_MOUNT_NOT_FOUND')
    depth = max(len(m['Destination']) for m in candidates)
    matches = [m for m in candidates if len(m['Destination']) == depth]
    require(len(matches) == 1, 'FIREBASE_MOUNT_AMBIGUOUS')
    mount = matches[0]
    require(mount.get('Type') in ['bind', 'volume'], 'UNSUPPORTED_FIREBASE_MOUNT')
    source = Path(mount['Source']).resolve()
    relative = credential_path[len(mount['Destination'].rstrip('/')):].lstrip('/')
    actual = (source / relative).resolve() if relative else source
    if relative:
        require(actual.is_relative_to(source), 'FIREBASE_MOUNT_ESCAPE_REFUSED')
    require(actual.is_file() and stat.S_ISREG(actual.stat().st_mode), 'FIREBASE_HOST_FILE_MISSING')
    try:
        account = json.loads(actual.read_text(encoding='utf-8'))
    except (OSError, ValueError):
        raise Stop('FIREBASE_HOST_FILE_INVALID') from None
    require(account.get('type') == 'service_account' and account.get('project_id') == 'al-mehrab-dashboard-231aa', 'FIREBASE_HOST_PROJECT_MISMATCH')
    return str(actual)

def discover_network(backend, containers, addresses, db_port):
    matches = []
    backend_networks = backend['NetworkSettings']['Networks']
    for container in containers:
        if container['Id'] == backend['Id']:
            continue
        for name, details in container.get('NetworkSettings', {}).get('Networks', {}).items():
            if details.get('IPAddress') in addresses and name in backend_networks:
                require(str(db_port) + '/tcp' in container['Config'].get('ExposedPorts', {}), 'DATABASE_TARGET_PORT_NOT_EXPOSED_IN_CONTAINER')
                require(re.search(r'(?:^|/)postgres(?::|@)', container['Config']['Image']) is not None, 'DATABASE_TARGET_NOT_POSTGRES_IMAGE')
                matches.append((name, container['Id']))
    require(len(set(matches)) == 1, 'DATABASE_NETWORK_OR_CONTAINER_AMBIGUOUS')
    return matches[0]

def verify_applications(api, backend_app, worker_app):
    require(backend_app.get('uuid') == API_APP and worker_app.get('uuid') == WORKER_APP, 'APPLICATION_ID_MISMATCH')
    for app in [backend_app, worker_app]:
        require(app.get('git_repository') == REPOSITORY and app.get('git_branch') == 'main', 'APPLICATION_REPOSITORY_MISMATCH')
    require(worker_app.get('build_pack') == 'dockercompose', 'WORKER_BUILD_PACK_MISMATCH')
    require(worker_app.get('docker_compose_location') == '/compose.fcm-worker.yaml', 'COMPOSE_LOCATION_MISMATCH')
    require(backend_app.get('destination_id') is not None and worker_app.get('destination_id') is not None, 'APPLICATION_DESTINATION_REQUIRED')
    require(backend_app.get('destination_id') == worker_app.get('destination_id') and
            backend_app.get('destination_type') == worker_app.get('destination_type'), 'APPLICATION_DESTINATION_MISMATCH')
    for key in ['pre_deployment_command', 'post_deployment_command', 'custom_docker_run_options',
                'docker_compose_custom_start_command', 'docker_compose_custom_build_command']:
        require(not worker_app.get(key), 'WORKER_CUSTOM_COMMAND_REQUIRES_REVIEW')

def download_sources(directory):
    revision = http_json('https://api.github.com/repos/' + REPOSITORY + '/commits/main')['sha']
    require(re.fullmatch(r'[a-f0-9]{40}', revision) is not None, 'INVALID_SOURCE_REVISION')
    require(bool(SOURCE_HASHES), 'REVIEWED_SOURCE_HASHES_MISSING')
    for name, expected in SOURCE_HASHES.items():
        url = 'https://raw.githubusercontent.com/' + REPOSITORY + '/' + revision + '/' + name
        try:
            with urllib.request.build_opener(NoRedirect()).open(url, timeout=30) as response:
                content = response.read(2_000_001)
        except (urllib.error.HTTPError, urllib.error.URLError):
            raise Stop('REVIEWED_FILES_NOT_PUBLISHED_OR_GITHUB_READ_ACCESS_REQUIRED') from None
        # Git may normalize Windows newlines. Only line endings are normalized.
        content = content.replace(b'\r\n', b'\n')
        require(hashlib.sha256(content).hexdigest() == expected, 'REVIEWED_SOURCE_NOT_PUBLISHED_OR_CHANGED_' + name)
        (directory / name).write_bytes(content)
    return revision

def verify_compose(config, env, source_dir):
    require(set(config.get('services', {})) == {'fcm-worker'}, 'UNEXPECTED_COMPOSE_SERVICE')
    service = config['services']['fcm-worker']
    require(service.get('command') == ['--check'], 'SENDING_COMMAND_REFUSED')
    require(service.get('restart') == 'no', 'RESTART_POLICY_REFUSED')
    require(not service.get('ports') and not service.get('expose') and not service.get('network_mode'), 'PUBLIC_OR_HOST_NETWORK_REFUSED')
    require(not service.get('privileged') and not service.get('entrypoint') and not service.get('volumes_from'), 'UNSAFE_COMPOSE_OVERRIDE')
    require(Path(service['build']['context']).resolve() == source_dir.resolve(), 'BUILD_CONTEXT_MISMATCH')
    require(service['build'].get('dockerfile') == 'Dockerfile.fcm-worker' and not service['build'].get('args'), 'BUILD_CONFIGURATION_MISMATCH')
    mounts = service.get('volumes', [])
    require(len(mounts) == 1 and mounts[0].get('type') == 'bind' and mounts[0].get('read_only') is True, 'MOUNT_CONFIGURATION_MISMATCH')
    require(mounts[0].get('source') == env['FCM_WORKER_FIREBASE_FILE'] and mounts[0].get('target') == TARGET, 'MOUNT_PATH_MISMATCH')
    require(set(service.get('networks', {})) == {'database-network'}, 'COMPOSE_NETWORK_MISMATCH')
    network = config['networks']['database-network']
    require(network.get('external') is True and network.get('name') == env['FCM_WORKER_DB_NETWORK'], 'EXTERNAL_NETWORK_MISMATCH')
    for key in REQUIRED + OPTIONAL + ['DB_PORT']:
        require(service['environment'].get(key) == env[key], 'RESOLVED_ENVIRONMENT_MISMATCH_' + key)

def safe_readiness(output):
    packets = []
    for line in output.splitlines():
        try:
            packet = json.loads(line)
        except ValueError:
            continue
        if isinstance(packet, dict) and packet.get('mode') == 'READINESS_ONLY':
            packets.append(packet)
    require(len(packets) == 1, 'READINESS_RESULT_MISSING')
    packet = packets[0]
    require(packet.get('sendingEnabled') is False and packet.get('compatible') is True and packet.get('instagramReady') is True, 'READINESS_FAILED')
    require(packet.get('activeWorkers') == 0, 'EXISTING_ACTIVE_WORKER_REQUIRES_REVIEW')
    devices = {k: packet.get('devices', {}).get(k) for k in ['registered', 'active', 'active_with_encrypted_token']}
    require(all(type(v) is int and v >= 0 for v in devices.values()), 'DEVICE_SUMMARY_INVALID')
    backlog = []
    for row in packet.get('backlog', []):
        require(row.get('channel') in ['whatsapp', 'messenger', 'instagram'] and type(row.get('pending_events')) is int, 'BACKLOG_SUMMARY_INVALID')
        backlog.append({'channel': row['channel'], 'pending_events': row['pending_events']})
    deliveries = []
    for row in packet.get('deliveries', []):
        require(row.get('status') in ['pending', 'sending', 'accepted', 'failed', 'skipped', 'expired'] and type(row.get('count')) is int, 'DELIVERY_SUMMARY_INVALID')
        deliveries.append({'status': row['status'], 'count': row['count']})
    return {'mode': 'READINESS_ONLY', 'databaseCompatible': True, 'firebaseAndInstagramPreflightPassed': True,
            'activeWorkers': 0, 'devices': devices, 'backlog': backlog, 'deliveries': deliveries, 'sendingEnabled': False}

def main():
    require(sys.version_info >= (3, 9), 'PYTHON_3_9_OR_NEWER_REQUIRED')
    require(os.geteuid() == 0, 'RUN_ON_COOLIFY_SERVER_AS_ROOT')
    os.umask(0o077)
    require(shutil.which('docker') is not None, 'DOCKER_REQUIRED')
    command(['docker', 'compose', 'version'])
    lock_file = open('/run/lock/mehrab-fcm-readiness-setup.lock', 'a')
    try:
        fcntl.flock(lock_file, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        raise Stop('ANOTHER_SETUP_IS_RUNNING') from None
    token = getpass.getpass('Coolify API Token (hidden): ')
    require(bool(token) and not any(c.isspace() for c in token), 'INVALID_API_TOKEN')
    api = lambda path, **kwargs: coolify_api(token, path, **kwargs)
    backend_app, worker_app = api('/applications/' + API_APP), api('/applications/' + WORKER_APP)
    verify_applications(api, backend_app, worker_app)
    ids = command(['docker', 'ps', '-q']).split()
    require(bool(ids), 'NO_RUNNING_CONTAINERS')
    containers = json.loads(command(['docker', 'inspect'] + ids))
    backends = [c for c in containers if belongs(c, API_APP)]
    require(len(backends) == 1, 'BACKEND_CONTAINER_AMBIGUOUS')
    backend = backends[0]
    require(backend['Config'].get('Cmd') == ['node', 'server.js'], 'BACKEND_COMMAND_REQUIRES_REVIEW')
    require(not any(belongs(c, WORKER_APP) for c in containers), 'WORKER_ALREADY_RUNNING')
    env = environment(backend)
    mount = discover_mount(backend, env['GOOGLE_APPLICATION_CREDENTIALS'])
    dns_script = "require('dns').lookup(process.env.DB_HOST,{all:true},(e,a)=>{if(e)process.exit(1);console.log(JSON.stringify(a.map(x=>x.address)))})"
    addresses = json.loads(command(['docker', 'exec', backend['Id'], 'node', '-e', dns_script]))
    network, database_id = discover_network(backend, containers, addresses, env['DB_PORT'])
    network_info = json.loads(command(['docker', 'network', 'inspect', network]))[0]
    require(network_info.get('Driver') == 'bridge' and network_info.get('Scope') == 'local', 'UNSUPPORTED_DATABASE_NETWORK')
    env['GOOGLE_APPLICATION_CREDENTIALS'] = TARGET
    env['FCM_WORKER_DB_NETWORK'], env['FCM_WORKER_FIREBASE_FILE'] = network, mount
    baseline = {c['Id']: (c['State']['StartedAt'], c.get('RestartCount', 0)) for c in containers
                if c['Id'] in [backend['Id'], database_id] or
                re.search(r'(?:^|/)n8n(?::|@)', c.get('Config', {}).get('Image', ''))}
    with tempfile.TemporaryDirectory(prefix='mehrab-fcm-readiness-') as temporary:
        directory = Path(temporary)
        revision = download_sources(directory)
        child_env = {k: v for k, v in os.environ.items() if k in ['PATH', 'HOME', 'DOCKER_HOST', 'DOCKER_CONTEXT', 'DOCKER_CONFIG']}
        child_env.update(env)
        compose = ['docker', 'compose', '--project-name', 'fcmcheck-' + WORKER_APP,
                   '--project-directory', str(directory), '-f', str(directory / 'compose.fcm-worker.yaml')]
        config = json.loads(command(compose + ['config', '--format', 'json'], env=child_env))
        verify_compose(config, env, directory)
        # Validate/build BEFORE changing Coolify configuration. Build output is suppressed.
        command(compose + ['build', 'fcm-worker'], env=child_env, timeout=900)
        readiness = safe_readiness(command(compose + ['run', '--rm', '--no-deps', '-T', '--entrypoint', 'node',
                                                    'fcm-worker', 'android-push-service.js', '--check'], env=child_env, timeout=90))
        # Only the NEW application is modified. Never call deploy/start/restart endpoints.
        api('/applications/' + WORKER_APP, method='PATCH', body={'is_auto_deploy_enabled': False, 'domains': '',
            'docker_compose_domains': [], 'health_check_enabled': False, 'git_commit_sha': revision})
        payload = {'data': [{'key': k, 'value': v, 'is_preview': False, 'is_literal': True,
                            'is_runtime': True, 'is_buildtime': False, 'is_shown_once': True} for k, v in env.items()]}
        api('/applications/' + WORKER_APP + '/envs/bulk', method='PATCH', body=payload)
        after = api('/applications/' + WORKER_APP)
        require(after.get('git_commit_sha') == revision and after.get('fqdn') in ['', None]
                and not after.get('is_auto_deploy_enabled'), 'WORKER_SETTINGS_SAVE_NOT_CONFIRMED')
        # Read-back of shown-once secrets is intentionally not forced or printed.
        live = json.loads(command(['docker', 'inspect'] + list(baseline)))
        require(all((c['State']['StartedAt'], c.get('RestartCount', 0)) == baseline[c['Id']]
                    and c['State']['Running'] for c in live), 'EXISTING_CONTAINER_STATE_CHANGED')
        print(json.dumps({'status': 'CONFIGURED_AND_READINESS_VERIFIED', 'workerApp': WORKER_APP,
                          'sourceRevision': revision, 'productionServicesUnchanged': True,
                          'coolifyWorkerNotStarted': True, **readiness}))

if __name__ == '__main__':
    try:
        main()
    except Stop as error:
        print(json.dumps({'status': 'STOPPED', 'reason': str(error), 'sendingEnabled': False}), flush=True)
        raise SystemExit(1)
    except (Exception, KeyboardInterrupt):
        print(json.dumps({'status': 'STOPPED', 'reason': 'UNEXPECTED_FAILURE_DETAILS_SUPPRESSED', 'sendingEnabled': False}), flush=True)
        raise SystemExit(1)
