#!/usr/bin/env python3
import aws_cdk as cdk
from fixwise_stack import FixwiseStack

app = cdk.App()
FixwiseStack(app, "Fixwise", env=cdk.Environment(region="us-east-1"),
             description="Fixwise Alexa+ MCP add-on (hackathon). Zero-spend design: on-demand, serverless, budget alarms.")
cdk.Tags.of(app).add("project", "fixwise")
cdk.Tags.of(app).add("cost-center", "aws-activate")
app.synth()
