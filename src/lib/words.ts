export const WORDS = [
  "pizza","robot","banana","castle","dragon","unicorn","skateboard","sandwich",
  "penguin","cactus","volcano","ninja","wizard","octopus","spaceship","mountain",
  "rainbow","sunglasses","guitar","camera","elephant","helicopter","mermaid",
  "pirate","snowman","telescope","vampire","watermelon","zebra","jellyfish",
  "keyboard","lighthouse","mushroom","parachute","scarecrow","tornado","trumpet",
  "windmill","koala","kangaroo","astronaut","bicycle","butterfly","campfire",
  "dinosaur","donut","firetruck","hamburger","igloo","lightning","moustache",
  "pineapple","rocket","sailboat","saxophone","scorpion","skeleton","sloth",
  "submarine","tiger","tractor","trophy","umbrella","vacuum","waffle","yo-yo",
  "anchor","balloon","bowtie","cupcake","drum","fireworks","ghost","hammer",
  "lollipop","microscope","ostrich","pumpkin","ladder","crown","goblin"
];

export function pickWords(n = 3): string[] {
  const out: string[] = [];
  const used = new Set<number>();
  while (out.length < n) {
    const i = Math.floor(Math.random() * WORDS.length);
    if (used.has(i)) continue;
    used.add(i);
    out.push(WORDS[i]);
  }
  return out;
}

export function maskWord(word: string): string {
  return word.split("").map((c) => (c === " " || c === "-" ? c : "_")).join(" ");
}
