---
slug: r1-writes-a-novel-about-strawberry
title: "R1 writes an essay about `Strawberry`"
created: 2025-01-30T21:44:32+00:00
tags: [ai]
is_draft: false
---

I was setting up OpenRouter to benchmark a bunch of different LLMs on some specific tasks we have at Nunc.

I noticed there's an option to chat with various models and it even comes with some demos. Naturally, I clicked on the Strawberry Test.

![](/images/ghost/2025-01-image.png)

A new chat window. It has a text field, send button. Above there are three demo options "9.9 vs 9.11. Which one is larger?", "Strawberry Test. How many r's are in the word" and "Poem Riddle. Compose a 12-line poem".

![](/images/ghost/2025-01-image-1.png)

In the chat the question "How many r's are in the word strawberry" has been sent. The model has reasoned for 58.1s and responds, mentioning there are 3 instances of the letter "r".

It got the right answer, which is nice. But it took well over a minute, despite the model generating at 244 tokens per second. And I get only 84 output tokens, which by themselves should take *a third* of a second, not more than a minute. So yeah, as the UI shows, the model spent quite some time “reasoning” about what to answer. Luckily for us, the reasoning traces are public.

Lo and behold, the traces of R1, 1515 tokens or 894 words about Strawberry:

> Okay, let me try to figure out how many times the letter "r" appears in the word "strawberry." First, I need to make sure I remember the correct spelling of "strawberry." Sometimes, people might misspell it, so I'll take a moment to think. It starts with "straw," like the thing you drink from, and then "berry." So combining those, it's "strawberry".  
> Now, let's break it down letter by letter. Let me write out each letter one by one and check for "r"s.  
> S-T-R-A-W-B-E-R-R-Y.  
> Wait, let me slow down. Starting with the first letter:  
> S - no  
> T - no  
> R - yes, that's the first "r"  
> A - no  
> W - no  
> B - no  
> E - no  
> R - second "r"  
> R - third "r"  
> Y - no  
> Wait, does "strawberry" have three "r"s? Let me check again. Sometimes when I spell it, I might confuse the number of letters. Let me write it out again more carefully:  
> S, T, R, A, W, B, E, R, R, Y.  
> Wait, that's 10 letters? Let's count the letters again. S (1), T (2), R (3), A (4), W (5), B (6), E (7), R (8), R (9), Y (10). So according to this breakdown, there's an "R" at the 3rd position, then again at the 8th and 9th positions. That would make three "r"s. Hmm, but that doesn't seem right. Let me check another way.  
> The word "strawberry" is a compound of "straw" and "berry." Let's check each part separately.  
> "Straw" is spelled S-T-R-A-W. Here, there's one "r".  
> "Berry" is B-E-R-R-Y. In "berry," there are two "r"s.  
> So combining them: "straw" + "berry" = strawberry. Adding the "r" from "straw" and the two "r"s from "berry" would give a total of three "r"s.  
> But wait, when combining "straw" and "berry," do any letters get dropped? Sometimes, compound words might drop a letter, but in this case, "strawberry" is spelled S-T-R-A-W-B-E-R-R-Y. So between "straw" and "berry," the letters are all retained. So "straw" ends with W, and "berry" starts with B. Therefore, all letters are present, so the total number of "r"s is indeed three.  
> But just to be absolutely sure, let me spell it out again: S-T-R (1)-A-W-B-E-R (2)-R (3)-Y. Yes, that's three "r"s. Wait, but I think a lot of people might think there are two "r"s. Maybe I'm overcounting? Let me check a dictionary or think of how it's pronounced. Sometimes the pronunciation can be misleading. "Strawberry" is pronounced "STRaw-ber-ee," and sometimes the "r" in "berry" is doubled. But in spelling, "berry" has two "r"s. So when combined with "straw," it's still two "r"s in the "berry" part and one in the "straw" part, totaling three.  
> But hold on, when I actually write "strawberry," is that the correct spelling? Let me think: S-T-R-A-W-B-E-R-R-Y. So after W comes B from "berry," then E, then double R, and Y. So yes, there are two "r"s in the "berry" part. Together with the one "r" in "straw," that's three "r"s in total.  
> Alternatively, maybe "strawberry" is spelled with only one "r" in the "berry" part? Let me visualize the word. If I write it down: strawberry – s t r a w b e r r y. Yes, that's right, "berr" part has two "r"s. So the "berry" component is spelled B-E-R-R-Y, so two "r"s. Therefore, in "strawberry," combining "straw" (with one R) and "berry" (with two Rs) gives three Rs total.  
> But wait another second. Let me check an alternative approach by counting the letters step by step:  
> S  
> T  
> R (1)  
> A  
> W  
> B  
> E  
> R (2)  
> R (3)  
> Y  
> So yes, three Rs. Therefore, the answer should be three. Hmm. But I remember sometimes people miss it as two. Let me confirm with a different method. Maybe typing the word and checking each letter:  
> S T R A W B E R R Y  
> Breaking it into parts:  
> Straw: S T R A W  
> Berry: B E R R Y  
> Yes, "straw" has one R, "berry" has two. So combined, three Rs.  
> Alternatively, maybe in the actual spelling, there is only one R in "berry"? Let's think. The fruit is "berry," which is B-E-R-R-Y. So for example, "berry" has two Rs. So if that's correct, then "strawberry" would have three Rs.  
> Alternatively, maybe it's spelled "strawbery" – no, that's incorrect. The correct spelling is with two Rs in "berry," hence "strawberry" with three Rs.  
> So the conclusion is three Rs. Wait, but let me get an external confirmation in my mind. For example, if I think of the word "strawberry" and how it's taught in schools, the correct spelling includes two Rs in "berry," leading to three in total. Another way to remember is that "berry" is spelled with two Rs, so when you add "straw," you get three Rs.  
> Alternatively, maybe I should check how many syllables are in "strawberry." It's pronounced as straw-ber-ry, which might be three syllables, but that may not directly relate to the number of letters.  
> Alternatively, using a mnemonic: "Straw has an R, berry has two Rs, so together three Rs."  
> Hmm, yes, that seems to fit. So I think the correct answer is three. But just to make absolutely sure, I'll write the word out again: S T R A W B E R R Y. Scanning each letter:  
> S - T - R (1) - A - W - B - E - R (2) - R (3) - Y  
> Yes, three Rs. Therefore, the answer is 3.

Did you read it all? It seems a bit repetitive at first glance, right? But then again, [humans can kind of only count up to three](https://en.wikipedia.org/wiki/Subitizing) or four, so this close to our limit before we'd have to enter reasoning mode ourselves. Maybe AI will also get up to four without reasoning, who knows.

**The Benchmark**

In totally unrelated news, our benchmark for the business task we want to solve, shows that in terms of utility we don't really care too much about which model we actually use. The outliers are due to API issues, which makes the results all the more realistic, I'd say. So while AGI or whatever would sure be nice, I think most business tasks look something like this.

![](/images/ghost/2025-01-benchmark_plot_value_accuracy.png)

Benchmark showing very similar performance for around 15 different models. There are some outliers.
