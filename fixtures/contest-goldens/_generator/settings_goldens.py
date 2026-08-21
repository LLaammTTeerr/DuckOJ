"""Settings overlay for the contest-golden harness.

The `online-judge` checkout is mounted read-only, so we cannot write `db.sqlite3`
into its BASE_DIR and we must not touch its settings.  This module imports the
real settings and overrides only what the harness needs.
"""
from dmoj.settings import *  # noqa: F401,F403

import os  # noqa: E402

DATABASES = {
    'default': {
        'ENGINE': os.environ.get('GOLDEN_DB_ENGINE', 'django.db.backends.sqlite3'),
        'NAME': os.environ.get('GOLDEN_DB_NAME', '/scratch/work/goldens.sqlite3'),
        'USER': os.environ.get('GOLDEN_DB_USER', ''),
        'PASSWORD': os.environ.get('GOLDEN_DB_PASSWORD', ''),
        'HOST': os.environ.get('GOLDEN_DB_HOST', ''),
        'PORT': os.environ.get('GOLDEN_DB_PORT', ''),
        'OPTIONS': {'charset': 'utf8mb4'} if os.environ.get('GOLDEN_DB_ENGINE', '').endswith('mysql') else {},
        'TEST': {'CHARSET': 'utf8mb4'},
    },
}

CACHES = {
    'default': {
        'BACKEND': 'django.core.cache.backends.locmem.LocMemCache',
        'LOCATION': 'goldens',
    },
}

# The harness never renders a page; keep static/compressor out of the way.
COMPRESS_ENABLED = False
COMPRESS_OFFLINE = False
DEBUG = False
EVENT_DAEMON_USE = False

# `local_settings.py` normally provides these; the checkout is read-only and has none.
STATIC_ROOT = '/scratch/work/static'
COMPRESS_ROOT = STATIC_ROOT
MEDIA_ROOT = '/scratch/work/media'
