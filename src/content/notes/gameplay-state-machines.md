---
title: State machines that stay readable
date: 2026-07-02
category: Gameplay code
reading_time: 8 min
excerpt: A compact pattern for player and tool states that preserves explicit transitions without turning every action into a class hierarchy.
---

The useful boundary is not between simple and complex states. It is between transitions that are visible to the reader and transitions that happen by accident. This note walks through a small implementation and its testing hooks.

