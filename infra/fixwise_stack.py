r"""Fixwise on AWS. Least-privilege roles, 14-day logs, budget.

Cloudflare Worker (alexa.culltron.app) -> Lambda Function URL -> Node 22 arm64 Lambda (MCP + OAuth + console) -> DynamoDB (on-demand, TTL)
   console turns: Bedrock Converse (Nova Lite, tool use) -> MCP client -> /mcp over HTTP
   SQS -> worker Lambda -> advisor note from Nova Lite via Converse (AgentCore Runtime only if agentImageUri is set, which it is not in production)
EventBridge keeps the MCP Lambda warm (Alexa+ needs < 500 ms). Secrets live in an SSM SecureString created out of band.
"""
from pathlib import Path

from aws_cdk import Aws, CfnOutput, Duration, RemovalPolicy, Stack
from aws_cdk import aws_bedrockagentcore as agentcore
from aws_cdk import aws_budgets as budgets
from aws_cdk import aws_cloudwatch as cw
from aws_cdk import aws_dynamodb as ddb
from aws_cdk import aws_events as events
from aws_cdk import aws_events_targets as targets
from aws_cdk import aws_iam as iam
from aws_cdk import aws_lambda as lambda_
from aws_cdk import aws_lambda_event_sources as sources
from aws_cdk import aws_logs as logs
from aws_cdk import aws_sqs as sqs
from constructs import Construct

ROOT = Path(__file__).resolve().parent.parent


class FixwiseStack(Stack):
    def __init__(self, scope: Construct, cid: str, **kw) -> None:
        super().__init__(scope, cid, **kw)
        ctx = self.node.try_get_context
        model_id = ctx("modelId") or "us.amazon.nova-lite-v1:0"
        image_uri = ctx("agentImageUri") or ""
        secrets_param = ctx("secretsParam") or "/fixwise/prod/secrets"
        budget_email = ctx("budgetEmail") or ""
        public_origin = ctx("publicOrigin") or ""
        origin_secret_file = ctx("originSecretFile") or ""  # 0600 file outside git; the Cloudflare Worker holds the same value as a secret
        origin_secret = Path(origin_secret_file).read_text().strip() if origin_secret_file else ""  # e.g. https://alexa.culltron.app (Cloudflare Worker proxy in front of the Function URL)

        table = ddb.Table(self, "State", partition_key=ddb.Attribute(name="pk", type=ddb.AttributeType.STRING),
                          billing_mode=ddb.BillingMode.PAY_PER_REQUEST, time_to_live_attribute="ttl",
                          point_in_time_recovery_specification=ddb.PointInTimeRecoverySpecification(point_in_time_recovery_enabled=False),
                          removal_policy=RemovalPolicy.DESTROY)
        dlq = sqs.Queue(self, "AdviceDLQ", retention_period=Duration.days(4), enforce_ssl=True)
        queue = sqs.Queue(self, "AdviceQueue", visibility_timeout=Duration.seconds(90), enforce_ssl=True,
                          dead_letter_queue=sqs.DeadLetterQueue(queue=dlq, max_receive_count=3))

        code = lambda_.Code.from_asset(str(ROOT / "build" / "lambda"))  # made by scripts/build-lambda.sh
        ssm_arn = f"arn:aws:ssm:{Aws.REGION}:{Aws.ACCOUNT_ID}:parameter{secrets_param}"
        common = {"TABLE_NAME": table.table_name, "SECRETS_PARAM": secrets_param, "ENVIRONMENT": "production", "NODE_OPTIONS": "--enable-source-maps"}

        def fn(cid_, handler, env, timeout, memory, reserved):
            group = logs.LogGroup(self, f"{cid_}Logs", retention=logs.RetentionDays.TWO_WEEKS, removal_policy=RemovalPolicy.DESTROY)
            f = lambda_.Function(self, cid_, runtime=lambda_.Runtime.NODEJS_22_X, architecture=lambda_.Architecture.ARM_64, handler=handler, code=code,
                                 timeout=Duration.seconds(timeout), memory_size=memory, environment=env, log_group=group,
                                 reserved_concurrent_executions=reserved)
            table.grant_read_write_data(f)
            f.add_to_role_policy(iam.PolicyStatement(actions=["ssm:GetParameter"], resources=[ssm_arn]))
            f.add_to_role_policy(iam.PolicyStatement(actions=["kms:Decrypt"], resources=[f"arn:aws:kms:{Aws.REGION}:{Aws.ACCOUNT_ID}:alias/aws/ssm"]))
            return f

        http_fn = fn("Mcp", "src/lambda.http", {**common, "QUEUE_URL": queue.queue_url, "SIM_MINUTES_PER_STAGE": "3", **({"PUBLIC_ORIGIN": public_origin} if public_origin else {}), **({"ORIGIN_SECRET": origin_secret} if origin_secret else {})}, 10, 1024, None)  # new accounts have a 10-concurrency quota; reserving any breaks deploy
        queue.grant_send_messages(http_fn)
        # Console planner: Nova Lite via Bedrock Converse (tool use). Nova models only, scoped to Nova ARNs.
        http_fn.add_environment("CONSOLE_MODEL_ID", model_id)
        http_fn.add_to_role_policy(iam.PolicyStatement(actions=["bedrock:InvokeModel"],
                                                       resources=["arn:aws:bedrock:*::foundation-model/amazon.nova-*", f"arn:aws:bedrock:*:{Aws.ACCOUNT_ID}:inference-profile/us.amazon.nova-*"]))
        worker = fn("Advisor", "src/lambda.worker", {**common, "BEDROCK_MODEL_ID": model_id}, 60, 512, None)
        worker.add_event_source(sources.SqsEventSource(queue, batch_size=1))
        worker.add_to_role_policy(iam.PolicyStatement(actions=["bedrock:InvokeModel"],  # Converse is authorised as InvokeModel; Nova only
                                                      resources=["arn:aws:bedrock:*::foundation-model/amazon.nova-*", f"arn:aws:bedrock:*:{Aws.ACCOUNT_ID}:inference-profile/us.amazon.nova-*"]))

        if image_uri:  # AgentCore runtime is created once the image is pushed (make agent-image)
            role = iam.Role(self, "AgentRuntimeRole", assumed_by=iam.ServicePrincipal("bedrock-agentcore.amazonaws.com"))
            role.add_to_policy(iam.PolicyStatement(actions=["bedrock:InvokeModel", "bedrock:InvokeModelWithResponseStream", "bedrock:Converse", "bedrock:ConverseStream"],
                                                   resources=["arn:aws:bedrock:*::foundation-model/*", f"arn:aws:bedrock:*:{Aws.ACCOUNT_ID}:inference-profile/*"]))
            role.add_to_policy(iam.PolicyStatement(actions=["ecr:BatchGetImage", "ecr:GetDownloadUrlForLayer"], resources=[f"arn:aws:ecr:{Aws.REGION}:{Aws.ACCOUNT_ID}:repository/fixwise-agent"]))
            role.add_to_policy(iam.PolicyStatement(actions=["ecr:GetAuthorizationToken"], resources=["*"]))
            role.add_to_policy(iam.PolicyStatement(actions=["logs:CreateLogGroup", "logs:CreateLogStream", "logs:PutLogEvents", "logs:DescribeLogStreams"],
                                                   resources=[f"arn:aws:logs:{Aws.REGION}:{Aws.ACCOUNT_ID}:log-group:/aws/bedrock-agentcore/runtimes/*"]))
            runtime = agentcore.CfnRuntime(self, "AdvisorRuntime", agent_runtime_name="fixwise_advisor", role_arn=role.role_arn,
                                           description="Fixwise advisor (Strands on Bedrock). Advice only; it cannot book or spend.",
                                           network_configuration=agentcore.CfnRuntime.NetworkConfigurationProperty(network_mode="PUBLIC"),
                                           protocol_configuration="HTTP",
                                           agent_runtime_artifact=agentcore.CfnRuntime.AgentRuntimeArtifactProperty(
                                               container_configuration=agentcore.CfnRuntime.ContainerConfigurationProperty(container_uri=image_uri)),
                                           environment_variables={"USE_BEDROCK": "1", "BEDROCK_MODEL_ID": model_id})
            runtime.node.add_dependency(role)
            worker.add_environment("AGENT_RUNTIME_ARN", runtime.attr_agent_runtime_arn)
            worker.add_to_role_policy(iam.PolicyStatement(actions=["bedrock-agentcore:InvokeAgentRuntime"],
                                                          resources=[runtime.attr_agent_runtime_arn, f"{runtime.attr_agent_runtime_arn}/runtime-endpoint/*"]))

        # Lambda Function URL instead of API Gateway: no extra billed service (Ash's zero-card rule). Reserved concurrency caps abuse.
        # Rotated 22 Oct 2026 (new construct id => CloudFormation replaces the URL config and the old hostname dies).
        # Auth NONE at AWS, but the handler rejects any request without the Worker's origin secret (403).
        # A function has one unqualified URL, so rotation is two deploys: -c skipFunctionUrl=1 (deletes the old), then a normal one.
        fn_url = None if ctx("skipFunctionUrl") else lambda_.FunctionUrl(self, "McpUrlV2", function=http_fn, auth_type=lambda_.FunctionUrlAuthType.NONE)

        events.Rule(self, "KeepWarm", schedule=events.Schedule.rate(Duration.minutes(5)),
                    targets=[targets.LambdaFunction(http_fn, event=events.RuleTargetInput.from_object({"source": "aws.events", "warm": True}))])

        cw.Alarm(self, "McpErrors", metric=http_fn.metric_errors(period=Duration.minutes(5)), threshold=5, evaluation_periods=1)
        cw.Alarm(self, "McpP95", metric=http_fn.metric_duration(statistic="p95", period=Duration.minutes(5)), threshold=400, evaluation_periods=2)
        cw.Alarm(self, "AdviceDLQDepth", metric=dlq.metric_approximate_number_of_messages_visible(), threshold=1, evaluation_periods=1)

        if budget_email:
            subs = [budgets.CfnBudget.SubscriberProperty(subscription_type="EMAIL", address=budget_email)]
            notes = [budgets.CfnBudget.NotificationWithSubscribersProperty(
                notification=budgets.CfnBudget.NotificationProperty(notification_type=t, comparison_operator="GREATER_THAN", threshold=th, threshold_type="ABSOLUTE_VALUE"),
                subscribers=subs) for t, th in (("ACTUAL", 20), ("ACTUAL", 50), ("FORECASTED", 50))]
            budgets.CfnBudget(self, "Budget", budget=budgets.CfnBudget.BudgetDataProperty(
                budget_name="fixwise-monthly", budget_type="COST", time_unit="MONTHLY", budget_limit=budgets.CfnBudget.SpendProperty(amount=50, unit="USD")),
                notifications_with_subscribers=notes)  # account-wide: catches any spend

        if fn_url:
            CfnOutput(self, "McpUrl", value=f"{fn_url.url}mcp")
        CfnOutput(self, "TableName", value=table.table_name)
