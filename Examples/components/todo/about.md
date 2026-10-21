Todo list: a checklist the user ticks and adds to; it keeps its own state with ccb.save, so ticks and new items stay (in the chat and on its pin).
Data: {"title":"Groceries","items":[{"text":"Milk","done":false},{"text":"Eggs","done":true}]}
title is optional. The user never answers it: each change is saved as the component's data, and the bot gets the latest list with the user's next message.
Sizes: 2x2, 2x3
Icon: checklist
