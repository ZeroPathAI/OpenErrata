#!/usr/bin/env bash
#
# Bootstrap the openerrata-ci IAM user for CI/CD Pulumi deployments.
#
# Run this ONCE with an AWS session that has IAM and STS permissions (e.g.
# an admin or root account).  It:
#
#   1. Verifies the AWS CLI is available and reads the account ID
#   2. Creates the openerrata-ci IAM user (skip if exists)
#   3. Creates or updates a customer managed policy scoped to the resources
#      Pulumi manages (S3 buckets, RDS instances, EC2 security groups,
#      IAM users for blob-storage writers) and attaches it
#   4. Creates an access key (skip if one already exists)
#   5. Prints credentials as JSON to stdout
#
# The policy is derived from every `new aws.*` resource in
# src/typescript/pulumi/index.ts.  The CI user has NO access to Lambda,
# ECS, EKS, DynamoDB, SQS, SNS, CloudFormation, Route53, CloudFront, or
# any non-openerrata S3/RDS/IAM resources.
#
# Usage:
#   ./setup.sh                        # prints credentials JSON to stdout
#   ./setup.sh > ci-credentials.json  # save to file
#
# Prerequisites:
#   - AWS CLI v2 installed and configured
#   - python3 available on PATH
#   - An active AWS session with IAM admin permissions
#
# The output JSON contains AccessKeyId and SecretAccessKey.  Set these as
# the AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY GitHub Actions secrets.

set -euo pipefail

IAM_USER="openerrata-ci"
POLICY_NAME="openerrata-ci-pulumi-deploy"

# ── 1. Prerequisites ──────────────────────────────────────────────────

if ! command -v aws &>/dev/null; then
  echo "ERROR: aws CLI not found. Install it first: https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html" >&2
  exit 1
fi

if ! command -v python3 &>/dev/null; then
  echo "ERROR: python3 not found. Install Python 3 and retry." >&2
  exit 1
fi

echo "Verifying AWS credentials ..." >&2
CALLER_IDENTITY="$(aws sts get-caller-identity --output json)"
ACCOUNT_ID="$(echo "$CALLER_IDENTITY" | python3 -c "import sys,json; print(json.load(sys.stdin)['Account'])")"
echo "Account ID: ${ACCOUNT_ID}" >&2

POLICY_ARN="arn:aws:iam::${ACCOUNT_ID}:policy/${POLICY_NAME}"

# ── 2. Create IAM user ────────────────────────────────────────────────

if aws iam get-user --user-name "$IAM_USER" &>/dev/null; then
  echo "IAM user ${IAM_USER} already exists." >&2
else
  echo "Creating IAM user ${IAM_USER} ..." >&2
  aws iam create-user \
    --user-name "$IAM_USER" \
    --tags \
      Key=managedBy,Value=bootstrap \
      Key=purpose,Value=ci-deploy
fi

# ── 3. Create or update managed policy and attach ────────────────────

# Uses a managed policy (6144-byte limit) instead of an inline policy
# (2048-byte limit) to accommodate the full set of resource ARNs that
# AWS validates during RDS and EC2 operations.

echo "Preparing managed policy ${POLICY_NAME} ..." >&2

# The policy document uses $ACCOUNT_ID from the shell.
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

# Remove the old inline policy if it exists (migration from inline to managed).
if aws iam get-user-policy --user-name "$IAM_USER" --policy-name "$POLICY_NAME" &>/dev/null; then
  echo "Removing legacy inline policy ..." >&2
  aws iam delete-user-policy --user-name "$IAM_USER" --policy-name "$POLICY_NAME"
fi

# Create or update the managed policy.
if aws iam get-policy --policy-arn "$POLICY_ARN" &>/dev/null; then
  echo "Updating existing managed policy ..." >&2

  # Managed policies have a 5-version limit.  Delete the oldest non-default
  # version before creating a new one to stay under the cap.
  OLD_VERSIONS="$(aws iam list-policy-versions --policy-arn "$POLICY_ARN" --output json \
    | python3 -c "
import sys, json
versions = json.load(sys.stdin)['Versions']
non_default = [v['VersionId'] for v in versions if not v['IsDefaultVersion']]
non_default.sort()
print('\n'.join(non_default))
")"

  VERSION_COUNT="$(aws iam list-policy-versions --policy-arn "$POLICY_ARN" --output json \
    | python3 -c "import sys, json; print(len(json.load(sys.stdin)['Versions']))")"

  if [ "$VERSION_COUNT" -ge 5 ] && [ -n "$OLD_VERSIONS" ]; then
    OLDEST="$(echo "$OLD_VERSIONS" | head -1)"
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

# Ensure the policy is attached to the user.
if ! aws iam list-attached-user-policies --user-name "$IAM_USER" --output json \
    | python3 -c "
import sys, json
policies = json.load(sys.stdin)['AttachedPolicies']
sys.exit(0 if any(p['PolicyArn'] == '$POLICY_ARN' for p in policies) else 1)
"; then
  echo "Attaching managed policy to ${IAM_USER} ..." >&2
  aws iam attach-user-policy --user-name "$IAM_USER" --policy-arn "$POLICY_ARN"
else
  echo "Managed policy already attached to ${IAM_USER}." >&2
fi

echo "Policy ${POLICY_NAME} ready." >&2

# ── 4. Create access key ──────────────────────────────────────────────

EXISTING_KEYS="$(aws iam list-access-keys --user-name "$IAM_USER" --output json)"
KEY_COUNT="$(echo "$EXISTING_KEYS" | python3 -c "import sys,json; print(len(json.load(sys.stdin)['AccessKeyMetadata']))")"

if [ "$KEY_COUNT" -gt "0" ]; then
  echo "" >&2
  echo "Access key(s) already exist for ${IAM_USER} (${KEY_COUNT} key(s))." >&2
  echo "The secret access key is only available at creation time." >&2
  echo "" >&2
  echo "To rotate:" >&2
  echo "  1. aws iam delete-access-key --user-name ${IAM_USER} --access-key-id <OLD_KEY_ID>" >&2
  echo "  2. Re-run this script" >&2
  echo "  3. Update the GitHub Actions secrets" >&2
  exit 0
fi

echo "Creating access key ..." >&2
ACCESS_KEY_JSON="$(aws iam create-access-key --user-name "$IAM_USER" --output json)"

# ── 5. Emit credentials ───────────────────────────────────────────────

ACCESS_KEY_ID="$(echo "$ACCESS_KEY_JSON" | python3 -c "import sys,json; print(json.load(sys.stdin)['AccessKey']['AccessKeyId'])")"
SECRET_ACCESS_KEY="$(echo "$ACCESS_KEY_JSON" | python3 -c "import sys,json; print(json.load(sys.stdin)['AccessKey']['SecretAccessKey'])")"

cat <<EOF
{
  "AccessKeyId": "${ACCESS_KEY_ID}",
  "SecretAccessKey": "${SECRET_ACCESS_KEY}"
}
EOF

echo "" >&2
echo "Credentials written to stdout." >&2
echo "Set AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY as GitHub Actions secrets." >&2
