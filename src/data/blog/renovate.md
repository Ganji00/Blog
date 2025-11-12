---
title: Keeping dependencies up to date with Renovate
author: Mateusz Kiersnowski
pubDatetime: 2025-10-21T20:52:11Z
slug: renovate
featured: true
draft: false
tags:
  - Dependencies
  - DevOps
  - GitLab
description:
  A quick guide on how to setup Renovate on self-hosted GitLab instance.
---

# Intro

Keeping dependencies up to date is a boring but necessary task. 
It's always easier to update dependencies regularly than to do a big update after a long time. Moreover,
security updates are crucial to keep the project safe. We all know that, but how to do it efficiently?

The answer is simple: automation. There are many tools available that can help with that. Recently, we have been exploring
this topic at work, and we decided to use [Renovate](https://github.com/renovatebot/renovate).
We really like it because it’s highly configurable and it officially supports self-hosted GitLab. It’s open source and has a great community.

In this post, I’ll share how to set up Renovate on self-hosted GitLab and a few lessons learned.

# How to set up Renovate?

It's nice that Renovate supports GitLab self-hosted providing a template project [renovate-runner](https://GitLab.com/GitLab-com/gl-infra/renovate/renovate-runner)
that can be used to run Renovate in your instance. The project contains all necessary files to run Renovate using Docker.

But Nevertheless, I found the official documentation a bit lacking in details, so here are some steps to follow:

1. **Create a new project** in your GitLab instance you might call it `renovate-runner`. This project will be responsible
for running centralized runner for dependency updates. It's easy to maintain consistency between projects that way. And if any
project-specific configuration is needed it can be tweaked in that repository.
2. Copy `templates` folder from the `renovate-runner` repository to your new project. This folder contains pre-configured
GitLab CI files that you can use to run Renovate.
3. You need to modify RENOVATE_ONBOARDING_CONFIG env var in `renovate.gitlab-ci.yml` to add default renovate configurations to onboarding MR's:

```yaml
RENOVATE_ONBOARDING_CONFIG: '{"$$schema": "https://docs.renovatebot.com/renovate-schema.json", "extends": ["config:recommended", "<project location>"] }
```

fill up the <project location\> with the renovate runner repository location that you are currently located at.

4. Create `.GitLab-ci.yml` file in the root of your project to run your runner. Copy the code below:

```yaml
include:
  - '/templates/renovate.GitLab-ci.yml'
  - '/templates/renovate-config-validator.GitLab-ci.yml'

variables:
  RENOVATE_CONFIG_VALIDATOR_EXTRA_FLAGS: default.json .GitLab/renovate.json
  RENOVATE_X_SQLITE_PACKAGE_CACHE: true
  RENOVATE_LOG_LEVEL: info
  RENOVATE_AUTODISCOVER: true

stages:
  - test
  - deploy

workflow:
  rules:
    # Don't build push pipeline when open MR and not renovate branch
    - if: $CI_COMMIT_BRANCH && $CI_OPEN_MERGE_REQUESTS && $CI_COMMIT_BRANCH !~ /^renovate\//
      when: never
    # Don't build MR pipeline when renovate branch
    - if: $CI_PIPELINE_SOURCE == "merge_request_event" && $CI_MERGE_REQUEST_SOURCE_BRANCH_NAME =~ /^renovate\//
      when: never
    # Don't build tags
    - if: $CI_COMMIT_TAG
      when: never
    - when: always

# Override the renovate job to run on schedule
renovate:
  extends: .renovate
  rules:
    - if: $CI_PIPELINE_SOURCE == "schedule"
  script:
    - renovate


renovate-config-validator:
  rules:
    - if: $CI_PIPELINE_SOURCE == "schedule"
      when: never
    - when: always
```
5. Create `default.json` file in the root of your project and copy the code below that will be used by default on every repository:
```json
{
  "$schema": "https://docs.renovatebot.com/renovate-schema.json",
  "extends": ["config:recommended", "mergeConfidence:all-badges"],
  "description": "Renovate preset",
  "addLabels": ["dependencies"],
  "rangeStrategy": "bump",
  "autodiscover": true,
  "packageRules": [
    {
      "groupName": "all patch/bugfix dependencies",
      "groupSlug": "all-patch",
      "matchPackageNames": [
        "*"
      ],
      "matchUpdateTypes": [
        "patch"
      ]
    }
  ]
}
```
This configuration will be used by default on every repository. You might override it in target repo by modifying
`renovate.json` file that is created during on-boarding MR.

Now we can move to bot and schedule set up.

## Setting up GitLab bot

I’m not sure why the Renovate docs don’t clearly explain (or maybe I just missed it) how to set up a 
GitLab bot for automated runs. You’ll want this to avoid ending up with hundreds of open MRs assigned to you.

A few things were confusing to me. 

Firstly, GitLab’s [internal users](https://docs.GitLab.com/administration/internal_users/) 
might seem like the right choice for a Renovate bot, but as far as I know, they can’t be created by 
GitLab admins, they’re built into GitLab. 

The second option was a [service account](https://docs.GitLab.com/user/profile/service_accounts/), which is what I ultimately went with. 

The third option I considered was creating a regular user for the Renovate bot, but that would count 
toward billable users, which I couldn’t accept.

After creating a service account, you need to create an access token for that account to enable api access. Make
sure that the token has those permissions:

`read_user, read_repository, read_virtual_registry, read_registry, read_api, write_repository, write_virtual_registry, write_registry, api`

Save that token for use in the next step This will be our RENOVATE_TOKEN.

Additionally, Renovate uses the GitHub API to fetch changelogs and other information for updated packages. 
To avoid hitting GitHub’s rate limits, create a personal access token. You can use any GitHub account or create 
a new one for this purpose. More details can be found [here](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens).
This token will be our RENOVATE_GITHUB_COM_TOKEN.

It's also nice to add an avatar for a created renovate service account, this can be done in users tab on GitLab's admin panel.

## Create a scheduled pipeline

To run renovate automatically, we need to setup a schedule pipeline runs. Moreover, we need to set up
 a few environment variables to run it as a previously created bot.

1. Setup Renovate Necessary CI/CD variables. To do so, go to Settings > CI/CD > Variables > Add variable.
- RENOVATE_TOKEN: <fill up the token from [previous step](#setting-up-GitLab-bot)>
- RENOVATE_GITHUB_COM_TOKEN: <fill up the Github token\>

You can mark them as Masked and hidden to improve security.

2. Setup pipeline schedule in Build > Pipeline schedules > New Schedule. Name it for example `renovate update`, set crone
time zone and preferred Interval Pattern. I would suggest running it every week at midnight. Target branch should be `main`. 
Save the changes.

## Run it!

With the current configuration, renovate will run on every repo it has access to. This means that a created Renovate bot needs
to be added to all repositories or groups that you want it to run on. This can be done in [Users menu](https://docs.GitLab.com/user/project/members). 

After this setup you should be able to run Renovate. In pipeline schedule menu you can select to `Run schedule pipeline` to run the pipeline now.

Renovate will now create an onboarding MR on every repo it has access to. Further steps will be described in that MR :).

You can check the pipeline logs for `INFO: Autodiscovered repositories...` To check on what repositories Renovate has run.

# Lessons learned

`RENOVATE_GITHUB_COM_TOKEN` is still needed on self‑hosted GitLab. Renovate queries GitHub for release notes, 
changelogs, and compare links, and unauthenticated requests hit strict rate limits; 
providing a token prevents throttling when it fetches dependency metadata from public repositories. 
It’s used for read‑only access to public GitHub data, more details can be found [here](https://docs.renovatebot.com/getting-started/private-packages/#looking-up-changelogs).