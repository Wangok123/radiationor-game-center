---
title: Profiling before optimizing
date: 2026-05-11
category: Performance
reading_time: 5 min
excerpt: A repeatable profiling pass for Unity scenes that turns a vague frame-time problem into a ranked list of work.
---

Start with a representative capture, then separate CPU, GPU, allocations, and loading. A profile is useful when it names the context of a cost, not when it merely proves that the frame is slow.

