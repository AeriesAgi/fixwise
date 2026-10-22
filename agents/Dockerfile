# AgentCore Runtime image (arm64, port 8080).
FROM --platform=linux/arm64 public.ecr.aws/docker/library/python:3.12-slim
WORKDIR /app
COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt
COPY fixwise_agent ./fixwise_agent
ENV PYTHONUNBUFFERED=1 USE_BEDROCK=1
EXPOSE 8080
CMD ["python", "-m", "fixwise_agent.advisor"]
