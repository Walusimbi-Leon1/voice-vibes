/**
 * Voice Vibes — word list (ported from the original Doodle Dash React app).
 * 80+ drawable words across fun categories.
 */

export const WORDS = [
  "pizza", "robot", "banana", "castle", "dragon", "unicorn", "skateboard", "sandwich",
  "penguin", "cactus", "volcano", "ninja", "wizard", "octopus", "spaceship", "mountain",
  "rainbow", "sunglasses", "guitar", "camera", "elephant", "helicopter", "mermaid",
  "pirate", "snowman", "telescope", "vampire", "watermelon", "zebra", "jellyfish",
  "keyboard", "lighthouse", "mushroom", "parachute", "scarecrow", "tornado", "trumpet",
  "windmill", "koala", "kangaroo", "astronaut", "bicycle", "butterfly", "campfire",
  "dinosaur", "donut", "firetruck", "hamburger", "igloo", "lightning", "moustache",
  "pineapple", "rocket", "sailboat", "saxophone", "scorpion", "skeleton", "sloth",
  "submarine", "tiger", "tractor", "trophy", "umbrella", "vacuum", "waffle", "yo-yo",
  "anchor", "balloon", "bowtie", "cupcake", "drum", "fireworks", "ghost", "hammer",
  "lollipop", "microscope", "ostrich", "pumpkin", "ladder", "crown", "goblin",
  // extras added for the global build
  "cake", "cat", "dog", "fish", "flower", "house", "tree", "star",
  "moon", "sun", "heart", "key", "lock", "book", "pencil", "phone",
];

export function pickWords(n = 3) {
  const out = [];
  const used = new Set();
  while (out.length < n) {
    const i = Math.floor(Math.random() * WORDS.length);
    if (used.has(i)) continue;
    used.add(i);
    out.push(WORDS[i]);
  }
  return out;
}

export function maskWord(word) {
  return word
    .split("")
    .map((c) => (c === " " || c === "-" ? c : "_"))
    .join(" ");
}
