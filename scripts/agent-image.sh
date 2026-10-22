#!/usr/bin/env bash
# Builds and pushes the AgentCore advisor image (arm64) to ECR, then prints AGENT_IMAGE_URI for deploy.sh.
# Needs Docker with buildx. Run on a machine with Docker; do not run on the shared box without the BOX_LOCK check.
set -euo pipefail
cd "$(dirname "$0")/../agents"
export AWS_REGION=us-east-1
ACCOUNT=$(aws sts get-caller-identity --query Account --output text)
REPO="$ACCOUNT.dkr.ecr.$AWS_REGION.amazonaws.com/fixwise-agent"
aws ecr describe-repositories --repository-names fixwise-agent >/dev/null 2>&1 || aws ecr create-repository --repository-name fixwise-agent --image-scanning-configuration scanOnPush=true >/dev/null
aws ecr put-lifecycle-policy --repository-name fixwise-agent --lifecycle-policy-text '{"rules":[{"rulePriority":1,"selection":{"tagStatus":"any","countType":"imageCountMoreThan","countNumber":2},"action":{"type":"expire"}}]}' >/dev/null
aws ecr get-login-password | docker login --username AWS --password-stdin "${REPO%/*}" >/dev/null
TAG=$(git rev-parse --short HEAD)
docker buildx build --platform linux/arm64 -t "$REPO:$TAG" --push .
echo "AGENT_IMAGE_URI=$REPO:$TAG"
