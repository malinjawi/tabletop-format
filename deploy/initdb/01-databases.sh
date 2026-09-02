#!/bin/bash
# Creates the two databases (forge + platform) with their own roles.
set -e
forge_db_pass="$(cat /run/secrets/forge_db_password)"
platform_db_pass="$(cat /run/secrets/platform_db_password)"
psql -v ON_ERROR_STOP=1 -v forge_db_pass="$forge_db_pass" -v platform_db_pass="$platform_db_pass" -U postgres <<-'SQL'
  CREATE ROLE forgejo LOGIN PASSWORD :'forge_db_pass';
  CREATE DATABASE forgejo OWNER forgejo;
  CREATE ROLE platform LOGIN PASSWORD :'platform_db_pass';
  CREATE DATABASE platform OWNER platform;
SQL
