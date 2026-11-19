`count_words` in `textstats/wordcount.py` gives wrong answers for ordinary text: newlines, tabs and repeated spaces inflate the count, and punctuation such as a dash between spaces is counted as a word.

A word is a maximal run of letters, digits, apostrophes (') or hyphens (-) that contains at least one letter or digit. Everything else separates words. `count_words("")` is 0.

Fix it. Keep the function's name and signature.
