#!/bin/sh
# Read a page, ask it a question, print the best quoted passages.
# Exit code: 0 read, 2 stopped on purpose (a wall, a refusal, a file), 1 an error.
set -u
url="${1:-https://example.com/}"
question="${2:-what is this page about}"
tiresias read "$url" --question "$question" --text
