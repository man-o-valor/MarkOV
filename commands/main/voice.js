const { SlashCommandBuilder, MessageFlags } = require("discord.js");
const { CMUDict } = require("cmudict");
const ffmpeg = require("fluent-ffmpeg");
const ffmpegStatic = require("ffmpeg-static");
const ffprobeStatic = require("ffprobe-static");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto"); 


ffmpeg.setFfmpegPath(ffmpegStatic);
ffmpeg.setFfprobePath(ffprobeStatic.path);

const cmudict = new CMUDict();

const soundsDir = path.join(__dirname, "..", "..", "phonemes");
const outputFile = path.join(__dirname, "..", "..", "output_speech.ogg");
const customWordsPath = path.join(__dirname, "..", "..", "words.json");

const VOWELS = new Set(["AA", "AE", "AH", "AO", "AW", "AY", "EH", "ER", "EY", "IH", "IY", "OW", "OY", "UH", "UW"]);


let customDictionary = {};
if (fs.existsSync(customWordsPath)) {
    try {
        customDictionary = JSON.parse(fs.readFileSync(customWordsPath, "utf-8"));
        console.log("Successfully loaded custom dictionary from words.json");
    } catch (err) {
        console.error("Error reading words.json, defaulting to standard dictionary:", err.message);
    }
}

function getPhonemeFiles(text, soundsDirectory) {
    const tokens = text.toLowerCase().match(/[a-z']+|[.,!?;: ]/g) || [];
    const audioPaths = [];
    const cleanPhonemes = [];

    
    function resolveWordPhonemes(word) {
        let phonemeString = "";
        if (customDictionary[word]) {
            phonemeString = customDictionary[word];
        } else {
            phonemeString = cmudict.get(word) || "";
        }

        if (phonemeString) {
            const phonemes = phonemeString.split(" ");
            phonemes.forEach((phoneme) => {
                const cleanPhoneme = phoneme.replace(/[0-9]/g, "");
                const filePath = path.join(soundsDirectory, `${cleanPhoneme}.mp3`);

                if (fs.existsSync(filePath)) {
                    audioPaths.push(filePath);
                    cleanPhonemes.push(cleanPhoneme);
                } else {
                    console.warn(`Warning: Missing audio file: "${cleanPhoneme}" (${filePath})`);
                }
            });
            
            audioPaths.push("REST_1.0");
            cleanPhonemes.push("·");
        } else {
            
            console.warn(`Word "${word}" not found in database. Spelling out as acronym.`);
            const letters = word.split("");
            letters.forEach((letter) => {
                resolveWordPhonemes(letter);
            });
        }
    }

    tokens.forEach((token) => {
        if ([".", "!", "?", ";", ":"].includes(token)) {
            audioPaths.push("REST_2.0");
            cleanPhonemes.push("··");
            return;
        }
        if (token === ",") {
            audioPaths.push("REST_1.0");
            cleanPhonemes.push("·");
            return;
        }
        if (token === " " || token === "") {
            return; 
        }

        resolveWordPhonemes(token);
    });

    while (audioPaths[audioPaths.length - 1]?.startsWith("REST_")) {
        audioPaths.pop();
        cleanPhonemes.pop();
    }

    return { audioPaths, cleanPhonemes };
}

function getAudioDuration(filePath) {
    return new Promise((resolve, reject) => {
        ffmpeg.ffprobe(filePath, (err, metadata) => {
            if (err) return reject(err);
            const duration = parseFloat(metadata.format.duration);
            resolve(duration);
        });
    });
}

function synthesizeToOgg(inputFiles, outputFilename, smoothness = 0.5, speed = 1.0) {
  return new Promise((resolve, reject) => {
    if (inputFiles.length === 0) {
      return reject(new Error("No valid phoneme audio files found to synthesize."));
    }

    const dir = path.dirname(outputFilename);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    const blendFactor = Math.max(0, Math.min(1, smoothness));
    const speedFactor = Math.max(0.5, Math.min(2.0, speed));

    const VOWEL_DURATION = 0.20;    
    const VOWEL_LOUDNESS = -14;     
    const CONSONANT_DURATION = VOWEL_DURATION / 2; 
    const CONSONANT_LOUDNESS = VOWEL_LOUDNESS + 4; 

    console.log(`Stitching ${inputFiles.length} nodes (Smoothness: ${blendFactor}, Speed: ${speedFactor}x)...`);

    const command = ffmpeg();
    const prepFilters = [];
    let fileInputIndex = 0;

    inputFiles.forEach((file, index) => {
      const outLabel = `[prep_${index}]`;

      if (file.startsWith("REST_")) {
        const multiplier = parseFloat(file.split("_")[1]);
        const restDuration = CONSONANT_DURATION * multiplier;
        prepFilters.push(`anullsrc=r=44100:cl=mono,atrim=0:${restDuration.toFixed(3)},asetpts=PTS-STARTPTS${outLabel}`);
      } else {
        command.input(file);
        const inLabel = `[${fileInputIndex}:a]`;
        fileInputIndex++;

        const fileName = path.basename(file, path.extname(file));
        const isVowel = VOWELS.has(fileName);

        const targetDuration = isVowel ? VOWEL_DURATION : CONSONANT_DURATION;
        const targetLoudness = isVowel ? VOWEL_LOUDNESS : CONSONANT_LOUDNESS;

        prepFilters.push(`${inLabel}atrim=0:${targetDuration},asetpts=PTS-STARTPTS,loudnorm=I=${targetLoudness}:TP=-1.5${outLabel}`);
      }
    });

    let filterString = prepFilters.join('; ') + '; ';
    let masterBlendOutput = "[prep_0]";

    if (inputFiles.length > 1) {
      let currentInputLabel = "[prep_0]";
      const blendFilters = [];

      for (let i = 1; i < inputFiles.length; i++) {
        const nextInputLabel = `[prep_${i}]`;
        const outLabel = `[blend_${i}]`;

        const prevFile = inputFiles[i - 1];
        const currentFile = inputFiles[i];

        let prevDuration = CONSONANT_DURATION;
        if (!prevFile.startsWith("REST_")) {
            const prevFileName = path.basename(prevFile, path.extname(prevFile));
            prevDuration = VOWELS.has(prevFileName) ? VOWEL_DURATION : CONSONANT_DURATION;
        }

        const hasPause = prevFile.startsWith("REST_") || currentFile.startsWith("REST_");
        let fadeDuration = (prevDuration / 2) * blendFactor;

        if (hasPause) {
            fadeDuration = 0.025; 
            blendFilters.push(`${currentInputLabel}${nextInputLabel}acrossfade=d=${fadeDuration.toFixed(3)}:c1=exp:c2=exp${outLabel}`);
        } else if (fadeDuration > 0) {
            blendFilters.push(`${currentInputLabel}${nextInputLabel}acrossfade=d=${fadeDuration.toFixed(3)}:c1=exp:c2=exp${outLabel}`);
        } else {
            blendFilters.push(`${currentInputLabel}${nextInputLabel}concat=n=2:v=0:a=1${outLabel}`);
        }

        currentInputLabel = outLabel;
      }

      filterString += blendFilters.join('; ');
      masterBlendOutput = `[blend_${inputFiles.length - 1}]`;
    }

    filterString += `; ${masterBlendOutput}atempo=${speedFactor.toFixed(2)}[outa]`;

    
    const tempFileName = `filter_${crypto.randomBytes(6).toString("hex")}.txt`;
    const tempFilterFile = path.join(process.cwd(), tempFileName);
    
    try {
      fs.writeFileSync(tempFilterFile, filterString, 'utf-8');
    } catch (writeErr) {
      return reject(new Error(`Failed to create temp filter script: ${writeErr.message}`));
    }

    
    command
      .inputOptions(['-filter_complex_script', tempFileName]) 
      .map('[outa]')
      .audioCodec('libvorbis') 
      .toFormat('ogg')
      .on('start', (commandLine) => {
         console.log('Spawned FFmpeg with command: ' + commandLine);
      })
      .on('error', (err) => {
        console.error('An error occurred during transcoding:', err.message);
        if (fs.existsSync(tempFilterFile)) fs.unlinkSync(tempFilterFile);
        reject(err);
      })
      .on('end', () => {
        if (fs.existsSync(tempFilterFile)) fs.unlinkSync(tempFilterFile);
        resolve(); 
      });

      
      command.save(outputFilename);
  });
}

module.exports = {
    data: new SlashCommandBuilder()
        .setName("voice")
        .setDescription("Have MarkOV record a voice message")
        .addStringOption((option) => option.setName("message").setDescription("What do you want MarkOV to say?").setRequired(true)),

    async execute(interaction) {
        await interaction.deferReply();

        const textToSay = interaction.options.getString("message");
        const smoothness = 0.3;
        const speed = 1.7;

        try {
            const { audioPaths, cleanPhonemes } = getPhonemeFiles(textToSay, soundsDir);

            await synthesizeToOgg(audioPaths, outputFile, smoothness, speed);

            const voiceAttachment = {
                attachment: outputFile,
                name: "markov.ogg",
                contentType: "audio/ogg"
            };

            const phonemeListString = cleanPhonemes.join(" ");
            const debugContent = `\`${textToSay}\``;

            await interaction.editReply({
                content: debugContent,
                files: [voiceAttachment],
                flags: [],
            });
        } catch (error) {
            console.error(error);
            await interaction.editReply({
                content: `Sorry, I ran into an error generating that message: ${error.message}`,
            });
        }
    },
};