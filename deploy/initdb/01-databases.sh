#!/bin/bash
# Creates the two databases (forge + platform) with their own roles.
set -e
psql -v ON_ERROR_STOP=1 -U postgres <<-SQL
  CREATE ROLE forgejo LOGIN PASSWORD '${FORGE_DB_PASS}';
  CREATE DATABASE forgejo OWNER forgejo;
  CREATE ROLE platform LOGIN PASSWORD '${PLATFORM_DB_PASS}';
  CREATE DATABASE platform OWNER platform;
SQL
