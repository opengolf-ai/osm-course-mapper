1. Select course from list
2. Verify boundaries of course -> edit if not right by editing the boundry lines
3. Select hole
4. Verify the path of the hole, allow the user to edit if needed. 
5. When path is confirmed and saved, ML model will try to identify tee boxes, sand, water, green, fairway, trees 
6. It will step through each of these, and include "additional hazards" identification. Each will allow the user to edit the shapes around the items, or add or remove items as they need to
    a. Tee boxes: List of all tees from the public hole data api, with yardage. 
        - If it found any tees with AI, (or furthest back tees should be where they started the hole path) then iterate over the tee box data and select the tee box shape for that tee box. If they click an area that isn't a tee box, it lets them draw a new shape for that tee box
        - Proceed through each tee box on the card (Black, blue, white, red, whatever)
    b. Green: Is that the green? (highlighted polygon around green)/ Options:
        - Yes, that's the green
        - That is not the green (let them find the green, click it, then edit the shape around it, then save)
        - Edges look off (let the user drag the edges to define the shape better, then save)
    c. Fairway: Is this outline of the fairway accurate? (let them drag multiple shapes if needed and save)
    d. Sand: We identified 3 bunkers on this hole. Did we miss any? Options:
        - That is all 3 of them
        - One of these is not sand (let them pick it and remove it)
        - There is another bunker (allow them to click it and draw a shape around it
        - Edges are off, let me update (make all sand edges editable then click save when done)
    f. Any other hazards?
        - Let them click anywhere and draw shapes, then mark it as "Water", "Tree", or "Other" or if you can think of any other types we can include
    
7. Save hole and it adds all the data into our own database, but stores enough fidelity that we can upload it to OSM when ready
