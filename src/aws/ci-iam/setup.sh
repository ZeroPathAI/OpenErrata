#!/usr/bin/env bash
#
# Bootstrap the IAM role the GitHub Actions deploy job assumes through GitHub
# OIDC, and the role's access to the cunningham EKS cluster.
#
# Run this with an AWS session that has IAM and EKS admin permissions in the
# account that hosts cunningham.  It is idempotent: rerun it after changing
# the policy below.  It:
#
#   1. Verifies the AWS CLI, the account, the existing GitHub OIDC provider
#      and the cluster's authentication mode
#   2. Creates or updates the role openerrata-github-actions-deploy, which
#      only GitHub OIDC tokens of this repository's `main` and `staging`
#      deployment environments may assume
#   3. Creates or updates a customer managed policy scoped to the resources
#      Pulumi manages (S3 buckets, RDS instances, EC2 security groups, IAM
#      users for blob-storage writers) plus eks:DescribeCluster on cunningham,
#      attaches it, and fails if the role holds any other policy
#   4. Creates or updates the role's EKS access entry: Kubernetes group
#      openerrata-ci (bound by src/kubernetes/ci-rbac/rbac.yaml) and no EKS
#      access policies, so the group's RBAC is all the role may do in-cluster
#   5. Prints, without running them, the commands that delete the retired
#      openerrata-ci IAM user and its policy, then the role ARN to stdout
#
# The policy is derived from every `new aws.*` resource and `aws.*` data
# source in src/typescript/pulumi/index.ts.  Security-group mutations are
# limited to groups tagged managedBy=pulumi, which Pulumi's groups carry.
# The role has NO access to Lambda, ECS, DynamoDB, SQS, SNS, CloudFormation,
# Route53, CloudFront, any non-openerrata S3/RDS/IAM resource, or any EKS
# API beyond describing cunningham.
#
# Usage:
#   ./setup.sh                                  # prints the role ARN to stdout
#   ROLE_ARN="$(./setup.sh)" && gh variable set AWS_DEPLOY_ROLE_ARN --repo ZeroPathAI/OpenErrata --body "$ROLE_ARN"
#
# Prerequisites:
#   - AWS CLI v2 installed and configured
#   - An active AWS session with IAM and EKS admin permissions
#   - The IAM OIDC provider token.actions.githubusercontent.com (shared with
#     other repositories' deploy roles; this script does not create it)

set -euo pipefail

GITHUB_REPOSITORY="ZeroPathAI/OpenErrata"
# The deploy job's `environment:`; GitHub puts it in the OIDC token's `sub`.
DEPLOY_ENVIRONMENTS=("main" "staging")
ROLE_NAME="openerrata-github-actions-deploy"
POLICY_NAME="openerrata-github-actions-deploy"
# Must match DEPLOY_EKS_CLUSTER and DEPLOY_AWS_REGION in .github/workflows/deploy.yml.
EKS_CLUSTER="cunningham"
EKS_REGION="us-west-2"
# Must match the RBAC subjects in src/kubernetes/ci-rbac/rbac.yaml.
KUBERNETES_GROUP="openerrata-ci"
OIDC_PROVIDER_HOST="token.actions.githubusercontent.com"
OIDC_AUDIENCE="sts.amazonaws.com"
# The static-key credentials this role replaces.
RETIRED_IAM_USER="openerrata-ci"
RETIRED_POLICY_NAME="openerrata-ci-pulumi-deploy"

# ── 1. Prerequisites ──────────────────────────────────────────────────

if ! command -v aws &>/dev/null; then
  echo "ERROR: aws CLI not found. Install it first: https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html" >&2
  exit 1
fi

if [[ "$(aws --version 2>&1)" != aws-cli/2.* ]]; then
  echo "ERROR: AWS CLI v2 is required (EKS access entries are not in v1). Found: $(aws --version 2>&1)" >&2
  exit 1
fi

echo "Verifying AWS credentials ..." >&2
ACCOUNT_ID="$(aws sts get-caller-identity --query Account --output text)"
echo "Account ID: ${ACCOUNT_ID}" >&2

OIDC_PROVIDER_ARN="arn:aws:iam::${ACCOUNT_ID}:oidc-provider/${OIDC_PROVIDER_HOST}"
POLICY_ARN="arn:aws:iam::${ACCOUNT_ID}:policy/${POLICY_NAME}"

echo "Checking GitHub OIDC provider ..." >&2
if ! OIDC_CLIENT_IDS="$(aws iam get-open-id-connect-provider \
    --open-id-connect-provider-arn "$OIDC_PROVIDER_ARN" \
    --query 'ClientIDList' --output text)"; then
  echo "ERROR: IAM OIDC provider ${OIDC_PROVIDER_ARN} not found. It is shared account infrastructure; create it before running this script." >&2
  exit 1
fi
if ! grep -qw -- "$OIDC_AUDIENCE" <<<"$OIDC_CLIENT_IDS"; then
  echo "ERROR: OIDC provider ${OIDC_PROVIDER_ARN} does not list audience ${OIDC_AUDIENCE} (has: ${OIDC_CLIENT_IDS})." >&2
  exit 1
fi

echo "Checking EKS cluster ${EKS_CLUSTER} ..." >&2
CLUSTER_INFO="$(aws eks describe-cluster \
  --name "$EKS_CLUSTER" --region "$EKS_REGION" \
  --query '[cluster.arn, cluster.accessConfig.authenticationMode]' --output text)"
read -r CLUSTER_ARN CLUSTER_AUTH_MODE <<<"$CLUSTER_INFO"
case "$CLUSTER_AUTH_MODE" in
  API|API_AND_CONFIG_MAP) ;;
  *)
    echo "ERROR: cluster ${EKS_CLUSTER} authentication mode is ${CLUSTER_AUTH_MODE}; EKS access entries need API or API_AND_CONFIG_MAP." >&2
    exit 1
    ;;
esac

# ── 2. Create or update the role ──────────────────────────────────────

SUBJECTS_JSON=""
for deploy_environment in "${DEPLOY_ENVIRONMENTS[@]}"; do
  SUBJECTS_JSON+="${SUBJECTS_JSON:+, }\"repo:${GITHUB_REPOSITORY}:environment:${deploy_environment}\""
done

TRUST_POLICY="$(cat <<EOF
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "GitHubActionsDeployEnvironments",
      "Effect": "Allow",
      "Principal": { "Federated": "${OIDC_PROVIDER_ARN}" },
      "Action": "sts:AssumeRoleWithWebIdentity",
      "Condition": {
        "StringEquals": {
          "${OIDC_PROVIDER_HOST}:aud": "${OIDC_AUDIENCE}",
          "${OIDC_PROVIDER_HOST}:sub": [${SUBJECTS_JSON}]
        }
      }
    }
  ]
}
EOF
)"

if aws iam get-role --role-name "$ROLE_NAME" &>/dev/null; then
  echo "Updating trust policy of role ${ROLE_NAME} ..." >&2
  aws iam update-assume-role-policy \
    --role-name "$ROLE_NAME" \
    --policy-document "$TRUST_POLICY"
else
  echo "Creating role ${ROLE_NAME} ..." >&2
  aws iam create-role \
    --role-name "$ROLE_NAME" \
    --assume-role-policy-document "$TRUST_POLICY" \
    --description "GitHub Actions deploys of ${GITHUB_REPOSITORY} (environments: ${DEPLOY_ENVIRONMENTS[*]})" \
    --tags Key=managedBy,Value=bootstrap Key=purpose,Value=ci-deploy > /dev/null
  aws iam wait role-exists --role-name "$ROLE_NAME"
fi

ROLE_ARN="$(aws iam get-role --role-name "$ROLE_NAME" --query 'Role.Arn' --output text)"

# ── 3. Create or update the managed policy and attach it ──────────────

# Uses a managed policy (6144-byte limit) instead of an inline policy
# (2048-byte limit) to accommodate the full set of resource ARNs that
# AWS validates during RDS and EC2 operations.

echo "Preparing managed policy ${POLICY_NAME} ..." >&2

# The policy document uses $ACCOUNT_ID and $CLUSTER_ARN from the shell.
POLICY_DOCUMENT="$(cat <<EOF
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "StsIdentity",
      "Effect": "Allow",
      "Action": "sts:GetCallerIdentity",
      "Resource": "*"
    },
    {
      "Sid": "EksDescribeDeployCluster",
      "Effect": "Allow",
      "Action": "eks:DescribeCluster",
      "Resource": "${CLUSTER_ARN}"
    },
    {
      "Sid": "S3ManagedBuckets",
      "Effect": "Allow",
      "Action": "s3:*",
      "Resource": [
        "arn:aws:s3:::openerrata-*",
        "arn:aws:s3:::openerrata-*/*"
      ]
    },
    {
      "Sid": "IamBlobStorageWriters",
      "Effect": "Allow",
      "Action": [
        "iam:CreateUser",
        "iam:DeleteUser",
        "iam:GetUser",
        "iam:TagUser",
        "iam:UntagUser",
        "iam:ListUserTags",
        "iam:PutUserPolicy",
        "iam:GetUserPolicy",
        "iam:DeleteUserPolicy",
        "iam:ListUserPolicies",
        "iam:CreateAccessKey",
        "iam:DeleteAccessKey",
        "iam:UpdateAccessKey",
        "iam:ListAccessKeys"
      ],
      "Resource": "arn:aws:iam::${ACCOUNT_ID}:user/blob-storage-writer-*"
    },
    {
      "Sid": "Ec2ReadOnly",
      "Effect": "Allow",
      "Action": [
        "ec2:DescribeVpcs",
        "ec2:DescribeVpcAttribute",
        "ec2:DescribeRouteTables",
        "ec2:DescribeSubnets",
        "ec2:DescribeSecurityGroups",
        "ec2:DescribeNetworkInterfaces",
        "ec2:DescribeAccountAttributes"
      ],
      "Resource": "*"
    },
    {
      "Sid": "Ec2SecurityGroupCreate",
      "Effect": "Allow",
      "Action": [
        "ec2:CreateSecurityGroup",
        "ec2:CreateTags"
      ],
      "Resource": "*"
    },
    {
      "Sid": "Ec2SecurityGroupMutate",
      "Effect": "Allow",
      "Action": [
        "ec2:DeleteSecurityGroup",
        "ec2:AuthorizeSecurityGroupIngress",
        "ec2:AuthorizeSecurityGroupEgress",
        "ec2:RevokeSecurityGroupIngress",
        "ec2:RevokeSecurityGroupEgress",
        "ec2:DeleteTags"
      ],
      "Resource": "*",
      "Condition": {
        "StringEquals": {
          "aws:ResourceTag/managedBy": "pulumi"
        }
      }
    },
    {
      "Sid": "RdsReadOnly",
      "Effect": "Allow",
      "Action": [
        "rds:DescribeDBInstances",
        "rds:DescribeDBSubnetGroups",
        "rds:ListTagsForResource"
      ],
      "Resource": "*"
    },
    {
      "Sid": "RdsMutateInstances",
      "Effect": "Allow",
      "Action": [
        "rds:CreateDBInstance",
        "rds:DeleteDBInstance",
        "rds:ModifyDBInstance",
        "rds:RebootDBInstance",
        "rds:AddTagsToResource",
        "rds:RemoveTagsFromResource"
      ],
      "Resource": [
        "arn:aws:rds:*:${ACCOUNT_ID}:db:openerrata-*",
        "arn:aws:rds:*:${ACCOUNT_ID}:subgrp:*",
        "arn:aws:rds:*:${ACCOUNT_ID}:pg:*",
        "arn:aws:rds:*:${ACCOUNT_ID}:og:*"
      ]
    },
    {
      "Sid": "RdsMutateSubnetGroups",
      "Effect": "Allow",
      "Action": [
        "rds:CreateDBSubnetGroup",
        "rds:DeleteDBSubnetGroup",
        "rds:ModifyDBSubnetGroup",
        "rds:AddTagsToResource",
        "rds:RemoveTagsFromResource"
      ],
      "Resource": "arn:aws:rds:*:${ACCOUNT_ID}:subgrp:*"
    }
  ]
}
EOF
)"

if aws iam get-policy --policy-arn "$POLICY_ARN" &>/dev/null; then
  echo "Updating existing managed policy ..." >&2

  # Managed policies have a 5-version limit.  Delete the oldest non-default
  # version before creating a new one to stay under the cap.
  VERSION_COUNT="$(aws iam list-policy-versions --policy-arn "$POLICY_ARN" \
    --query 'length(Versions)' --output text)"
  if [ "$VERSION_COUNT" -ge 5 ]; then
    OLDEST="$(aws iam list-policy-versions --policy-arn "$POLICY_ARN" \
      --query 'sort_by(Versions[?IsDefaultVersion==`false`], &CreateDate)[0].VersionId' --output text)"
    echo "Deleting oldest policy version ${OLDEST} to make room ..." >&2
    aws iam delete-policy-version --policy-arn "$POLICY_ARN" --version-id "$OLDEST"
  fi

  aws iam create-policy-version \
    --policy-arn "$POLICY_ARN" \
    --policy-document "$POLICY_DOCUMENT" \
    --set-as-default > /dev/null
else
  echo "Creating managed policy ..." >&2
  aws iam create-policy \
    --policy-name "$POLICY_NAME" \
    --policy-document "$POLICY_DOCUMENT" \
    --description "Least-privilege policy for openerrata CI/CD Pulumi deployments" \
    --tags Key=managedBy,Value=bootstrap Key=purpose,Value=ci-deploy > /dev/null
fi

# Attaching an already-attached policy is a no-op.
aws iam attach-role-policy --role-name "$ROLE_NAME" --policy-arn "$POLICY_ARN"

OTHER_ATTACHED_POLICIES="$(aws iam list-attached-role-policies --role-name "$ROLE_NAME" \
  --query "AttachedPolicies[?PolicyArn!='${POLICY_ARN}'].PolicyArn" --output text)"
INLINE_POLICIES="$(aws iam list-role-policies --role-name "$ROLE_NAME" \
  --query 'PolicyNames' --output text)"
if [ -n "$OTHER_ATTACHED_POLICIES" ] || [ -n "$INLINE_POLICIES" ]; then
  echo "ERROR: role ${ROLE_NAME} holds permissions beyond ${POLICY_NAME}. Remove them and rerun:" >&2
  for policy_arn in $OTHER_ATTACHED_POLICIES; do
    echo "  aws iam detach-role-policy --role-name ${ROLE_NAME} --policy-arn ${policy_arn}" >&2
  done
  for policy_name in $INLINE_POLICIES; do
    echo "  aws iam delete-role-policy --role-name ${ROLE_NAME} --policy-name ${policy_name}" >&2
  done
  exit 1
fi

echo "Policy ${POLICY_NAME} attached to ${ROLE_NAME}." >&2

# ── 4. Create or update the EKS access entry ──────────────────────────

if aws eks describe-access-entry \
    --cluster-name "$EKS_CLUSTER" --region "$EKS_REGION" \
    --principal-arn "$ROLE_ARN" &>/dev/null; then
  echo "Updating EKS access entry on ${EKS_CLUSTER} ..." >&2
  aws eks update-access-entry \
    --cluster-name "$EKS_CLUSTER" --region "$EKS_REGION" \
    --principal-arn "$ROLE_ARN" \
    --kubernetes-groups "$KUBERNETES_GROUP" > /dev/null
else
  echo "Creating EKS access entry on ${EKS_CLUSTER} ..." >&2
  # EKS rejects a just-created role as "invalid principal" until IAM's
  # eventual consistency catches up (observed: seconds), so retry that error.
  for attempt in $(seq 1 12); do
    if CREATE_OUTPUT="$(aws eks create-access-entry \
        --cluster-name "$EKS_CLUSTER" --region "$EKS_REGION" \
        --principal-arn "$ROLE_ARN" \
        --type STANDARD \
        --kubernetes-groups "$KUBERNETES_GROUP" 2>&1 >/dev/null)"; then
      break
    fi
    if [[ "$CREATE_OUTPUT" != *"invalid principal"* ]] || [ "$attempt" -eq 12 ]; then
      echo "$CREATE_OUTPUT" >&2
      exit 1
    fi
    echo "Role not yet visible to EKS; retrying in 5s (attempt ${attempt}/12) ..." >&2
    sleep 5
  done
fi

ASSOCIATED_ACCESS_POLICIES="$(aws eks list-associated-access-policies \
  --cluster-name "$EKS_CLUSTER" --region "$EKS_REGION" \
  --principal-arn "$ROLE_ARN" \
  --query 'associatedAccessPolicies[].policyArn' --output text)"
if [ -n "$ASSOCIATED_ACCESS_POLICIES" ]; then
  echo "ERROR: the EKS access entry of ${ROLE_NAME} has access policies; its only cluster access must be the ${KUBERNETES_GROUP} group's RBAC. Remove them and rerun:" >&2
  for policy_arn in $ASSOCIATED_ACCESS_POLICIES; do
    echo "  aws eks disassociate-access-policy --cluster-name ${EKS_CLUSTER} --region ${EKS_REGION} --principal-arn ${ROLE_ARN} --policy-arn ${policy_arn}" >&2
  done
  exit 1
fi

echo "EKS access entry ready: ${ROLE_NAME} → Kubernetes group ${KUBERNETES_GROUP}." >&2

# ── 5. Retired static-key credentials ─────────────────────────────────

echo "" >&2
if aws iam get-user --user-name "$RETIRED_IAM_USER" &>/dev/null; then
  echo "The retired IAM user ${RETIRED_IAM_USER} still exists. Once a deploy has succeeded with ${ROLE_NAME}, delete it:" >&2
  for key_id in $(aws iam list-access-keys --user-name "$RETIRED_IAM_USER" \
      --query 'AccessKeyMetadata[].AccessKeyId' --output text); do
    echo "  aws iam delete-access-key --user-name ${RETIRED_IAM_USER} --access-key-id ${key_id}" >&2
  done
  for policy_arn in $(aws iam list-attached-user-policies --user-name "$RETIRED_IAM_USER" \
      --query 'AttachedPolicies[].PolicyArn' --output text); do
    echo "  aws iam detach-user-policy --user-name ${RETIRED_IAM_USER} --policy-arn ${policy_arn}" >&2
  done
  for policy_name in $(aws iam list-user-policies --user-name "$RETIRED_IAM_USER" \
      --query 'PolicyNames' --output text); do
    echo "  aws iam delete-user-policy --user-name ${RETIRED_IAM_USER} --policy-name ${policy_name}" >&2
  done
  for group_name in $(aws iam list-groups-for-user --user-name "$RETIRED_IAM_USER" \
      --query 'Groups[].GroupName' --output text); do
    echo "  aws iam remove-user-from-group --user-name ${RETIRED_IAM_USER} --group-name ${group_name}" >&2
  done
  if aws iam get-login-profile --user-name "$RETIRED_IAM_USER" &>/dev/null; then
    echo "  aws iam delete-login-profile --user-name ${RETIRED_IAM_USER}" >&2
  fi
  # delete-user names anything else still attached (MFA devices, SSH keys, ...).
  echo "  aws iam delete-user --user-name ${RETIRED_IAM_USER}" >&2
else
  echo "The retired IAM user ${RETIRED_IAM_USER} is already deleted." >&2
fi

RETIRED_POLICY_ARN="arn:aws:iam::${ACCOUNT_ID}:policy/${RETIRED_POLICY_NAME}"
if aws iam get-policy --policy-arn "$RETIRED_POLICY_ARN" &>/dev/null; then
  echo "The retired managed policy ${RETIRED_POLICY_NAME} still exists. Delete it (after detaching it from every entity):" >&2
  for version_id in $(aws iam list-policy-versions --policy-arn "$RETIRED_POLICY_ARN" \
      --query 'Versions[?IsDefaultVersion==`false`].VersionId' --output text); do
    echo "  aws iam delete-policy-version --policy-arn ${RETIRED_POLICY_ARN} --version-id ${version_id}" >&2
  done
  echo "  aws iam delete-policy --policy-arn ${RETIRED_POLICY_ARN}" >&2
fi

echo "" >&2
echo "Set the role ARN below as the AWS_DEPLOY_ROLE_ARN GitHub Actions variable." >&2
echo "${ROLE_ARN}"
