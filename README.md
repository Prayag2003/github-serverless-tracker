# GitHub Activity Tracker

A beautifully simple, entirely serverless AWS Lambda function that monitors a GitHub user account for new activity and sends visually rich, professionally formatted HTML email updates when public events (like commits, PRs, issues) are detected.

It dynamically pulls secrets from AWS SSM during execution, keeping credentials entirely safe and off your servers. Driven by an AWS EventBridge scheduler, this system requires zero operational overhead or constantly running servers.

## Features
- **Serverless & Stateless**: Runs on AWS Lambda, scaling instantly and costing fractions of a cent per run.
- **Automated Polling**: Utilizes AWS EventBridge to wake up and poll the GitHub API every 30 minutes.
- **Commit Drilldowns**: Deeply integrates with the GitHub Compare API to pull full commit messages, author details, and short hashes when users push code.
- **Secure Configuration**: Retrieves `.env` equivalents (API keys, target email, GitHub username) securely from AWS Systems Manager (SSM) Parameter Store.
- **Beautiful Emails**: Constructs rich Apple-style HTML emails dispatched flawlessly via Resend.

## AWS Architecture

```text
  [ AWS EventBridge Scheduler ]
               |
               | Triggers every 30 mins
               v
     [ AWS Lambda Function ] ----------> [ AWS KMS (Decrypt Secrets) ]
           (tracker.js)      ----------> [ AWS SSM (Fetch API Keys) ]
               |
               | Poll public events
               v
         [ GitHub API ]
               |
               | If new events/commits found
               v
      [ Resend Email API ]
               |
               | Delivered to user
               v
         [ User Inbox ]
```

## Setup & Deployment

1. **Install AWS SAM CLI**: Make sure you have the [AWS Serverless Application Model (SAM) CLI](https://aws.amazon.com/serverless/sam/) installed.
2. **Set up SSM Parameters**: Create SecureString parameters in AWS Systems Manager mapping to your setup under the path `/github-tracker/prod/`:
   - `/github-tracker/prod/resend-api-key`
   - `/github-tracker/prod/github-username`
   - `/github-tracker/prod/notify-email`
3. **Deploy using SAM**: Run the standard deployment flow:
   ```bash
   sam build
   sam deploy --guided
   ```
   *Note: Using AWS SAM means `template.yaml` and `samconfig.toml` are strictly required to define the architecture and remember deployment locations.*

## Development
If you're testing functionality locally without SAM, simply create a local `.env` with variables `GITHUB_USERNAME`, `NOTIFY_EMAIL`, and `RESEND_API_KEY`.